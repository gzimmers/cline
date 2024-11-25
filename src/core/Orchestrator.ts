import { Anthropic } from "@anthropic-ai/sdk";
import cloneDeep from "clone-deep";
import delay from "delay";
import fs from "fs/promises";
import os from "os";
import * as path from "path";
import * as vscode from "vscode";
import { ApiHandler, buildApiHandler } from "../api";
import { DiffViewProvider } from "../integrations/editor/DiffViewProvider";
import { TerminalManager } from "../integrations/terminal/TerminalManager";
import { UrlContentFetcher } from "../services/browser/UrlContentFetcher";
import { parseSourceCodeForDefinitionsTopLevel } from "../services/tree-sitter";
import { ApiConfiguration } from "../shared/api";
import {
  BrowserAction,
  BrowserActionResult,
  browserActions,
  ClineAsk,
  ClineMessage,
  ClineSay,
  ClineSayBrowserAction,
  ClineSayTool,
} from "../shared/ExtensionMessage";
import { HistoryItem } from "../shared/HistoryItem";
import { ClineAskResponse } from "../shared/WebviewMessage";
import { calculateApiCost } from "../utils/cost";
import { fileExistsAtPath } from "../utils/fs";
import { arePathsEqual, getReadablePath } from "../utils/path";
import { AssistantMessageContent } from "./assistant-message";
import { ClineProvider, GlobalFileNames } from "./webview/ClineProvider";
import { BrowserSession } from "../services/browser/BrowserSession";

// Constants
const cwd =
  vscode.workspace.workspaceFolders?.map((folder) => folder.uri.fsPath).at(0) ??
  path.join(os.homedir(), "Desktop");

// Types
type ToolResponse = string | Array<Anthropic.TextBlockParam | Anthropic.ImageBlockParam>;
type UserContent = Array<
  Anthropic.TextBlockParam | Anthropic.ImageBlockParam | Anthropic.ToolUseBlockParam | Anthropic.ToolResultBlockParam
>;

// ConversationManager handles conversation history
class ConversationManager {
  apiConversationHistory: Anthropic.MessageParam[] = [];
  private taskId: string;

  constructor(taskId: string) {
    this.taskId = taskId;
  }

  async ensureTaskDirectoryExists(): Promise<string> {
    const globalStoragePath = vscode.Uri.joinPath(
      vscode.workspace.workspaceFolders![0].uri,
      ".vscode",
      "tasks",
      this.taskId
    ).fsPath;
    await fs.mkdir(globalStoragePath, { recursive: true });
    return globalStoragePath;
  }

  async getSavedApiConversationHistory(): Promise<Anthropic.MessageParam[]> {
    const filePath = path.join(await this.ensureTaskDirectoryExists(), GlobalFileNames.apiConversationHistory);
    const fileExists = await fileExistsAtPath(filePath);
    if (fileExists) {
      return JSON.parse(await fs.readFile(filePath, "utf8"));
    }
    return [];
  }

  async addToApiConversationHistory(message: Anthropic.MessageParam) {
    this.apiConversationHistory.push(message);
    await this.saveApiConversationHistory();
  }

  async saveApiConversationHistory() {
    try {
      const filePath = path.join(await this.ensureTaskDirectoryExists(), GlobalFileNames.apiConversationHistory);
      await fs.writeFile(filePath, JSON.stringify(this.apiConversationHistory));
    } catch (error) {
      console.error("Failed to save API conversation history:", error);
    }
  }
}

// UIManager handles UI interactions with VSCode
class UIManager {
  private clineMessages: ClineMessage[] = [];
  private providerRef: WeakRef<ClineProvider>;

  constructor(provider: ClineProvider) {
    this.providerRef = new WeakRef(provider);
  }

  async getSavedClineMessages(taskId: string): Promise<ClineMessage[]> {
    const filePath = path.join(
      vscode.Uri.joinPath(
        vscode.workspace.workspaceFolders![0].uri,
        ".vscode",
        "tasks",
        taskId,
        GlobalFileNames.uiMessages
      ).fsPath
    );
    if (await fileExistsAtPath(filePath)) {
      return JSON.parse(await fs.readFile(filePath, "utf8"));
    }
    return [];
  }

  async addToClineMessages(message: ClineMessage, taskId: string) {
    this.clineMessages.push(message);
    await this.saveClineMessages(taskId);
  }

  async saveClineMessages(taskId: string) {
    try {
      const filePath = path.join(
        vscode.Uri.joinPath(
          vscode.workspace.workspaceFolders![0].uri,
          ".vscode",
          "tasks",
          taskId,
          GlobalFileNames.uiMessages
        ).fsPath
      );
      await fs.writeFile(filePath, JSON.stringify(this.clineMessages));
    } catch (error) {
      console.error("Failed to save cline messages:", error);
    }
  }

  async ask(
    type: ClineAsk,
    text?: string,
    partial?: boolean
  ): Promise<{ response: ClineAskResponse; text?: string; images?: string[] }> {
    // Implement ask logic
    // ...
    return { response: "yesButtonClicked" };
  }

  async say(type: ClineSay, text?: string, images?: string[], partial?: boolean): Promise<void> {
    // Implement say logic
    // ...
  }
}

// ToolExecutor handles execution of tools
class ToolExecutor {
  private terminalManager: TerminalManager;
  private browserSession: BrowserSession;
  private diffViewProvider: DiffViewProvider;

  constructor(readonly context: vscode.ExtensionContext) {
    this.terminalManager = new TerminalManager();
    this.browserSession = new BrowserSession(context);
    this.diffViewProvider = new DiffViewProvider(cwd);
  }

  async executeCommandTool(command: string): Promise<[boolean, ToolResponse]> {
    // Implement command execution logic
    // ...
    return [false, "Command executed."];
  }

  // Add other tool execution methods as needed
}

// Cline class orchestrates the interactions
export class Cline {
  readonly taskId: string;
  api: ApiHandler;
  private uiManager: UIManager;
  private conversationManager: ConversationManager;
  private customInstructions?: string;
  private alwaysAllowReadOnly: boolean;

  constructor(
    provider: ClineProvider,
    apiConfiguration: ApiConfiguration,
    customInstructions?: string,
    alwaysAllowReadOnly?: boolean,
    task?: string,
    images?: string[],
    historyItem?: HistoryItem
  ) {
    this.api = buildApiHandler(apiConfiguration);
    this.uiManager = new UIManager(provider);
    this.customInstructions = customInstructions;
    this.alwaysAllowReadOnly = alwaysAllowReadOnly ?? false;

    if (historyItem) {
      this.taskId = historyItem.id;
      this.conversationManager = new ConversationManager(this.taskId);
      this.resumeTaskFromHistory();
    } else if (task || images) {
      this.taskId = Date.now().toString();
      this.conversationManager = new ConversationManager(this.taskId);
      this.startTask(task, images);
    } else {
      throw new Error("Either historyItem or task/images must be provided");
    }
  }

  // Start a new task
  private async startTask(task?: string, images?: string[]): Promise<void> {
    // Reset messages and conversation history
    await this.uiManager.addToClineMessages({ ts: Date.now(), type: "say", say: "text", text: task, images }, this.taskId);

    // Prepare initial content for the external multi-agent system
    const initialContent: UserContent = [
      {
        type: "text",
        text: `<task>\n${task}\n</task>`,
      },
      // ...formatResponse.imageBlocks(images),
    ];

    // Notify external multi-agent system (this method needs to be implemented)
    await this.notifyExternalSystem(initialContent);
  }

  // Resume task from history
  private async resumeTaskFromHistory() {
    const clineMessages = await this.uiManager.getSavedClineMessages(this.taskId);

    // Prepare content for external multi-agent system
    const userContent: UserContent = clineMessages.map((message) => ({
      type: "text",
      text: message.text ?? "",
    }));

    // Notify external multi-agent system
    await this.notifyExternalSystem(userContent);
  }

  // Placeholder for integration with external multi-agent system
  private async notifyExternalSystem(content: UserContent): Promise<void> {
    // Implement integration logic here
    // For example, send the content to the external system via an API call
  }

  // Other methods remain unchanged or are refactored into their respective classes
}
