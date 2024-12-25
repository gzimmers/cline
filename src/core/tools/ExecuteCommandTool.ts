import { Tool, ToolParams, ToolResult, ToolContext } from "./Tool"
import { ClineSayTool } from "../../shared/ExtensionMessage"
import { TerminalManager } from "../../integrations/terminal/TerminalManager"
import { formatResponse } from "../prompts/responses"
import { MessageHandler } from "../messages/MessageHandler"
import delay from "delay"

interface ExecuteCommandParams extends ToolParams {
    command?: string
}

export class ExecuteCommandTool extends Tool<ExecuteCommandParams> {
    private terminalManager: TerminalManager
    private messageHandler: MessageHandler

    constructor(context: ToolContext, terminalManager: TerminalManager, messageHandler: MessageHandler) {
        super(context)
        this.terminalManager = terminalManager
        this.messageHandler = messageHandler
    }

    validateParams(params: ExecuteCommandParams): string | undefined {
        if (!params.command) return "command"
        return undefined
    }

    formatToolMessage(params: ExecuteCommandParams): ClineSayTool {
        return {
            tool: "searchFiles", // Using searchFiles as a base type since we just need a simple message format
            path: "",
            content: params.command
        }
    }

    async execute(params: ExecuteCommandParams): Promise<ToolResult> {
        const terminalInfo = await this.terminalManager.getOrCreateTerminal(this.context.cwd)
        terminalInfo.terminal.show()
        const process = this.terminalManager.runCommand(terminalInfo, params.command!)

        let userFeedback: { text?: string; images?: string[] } | undefined
        let didContinue = false
        let result = ""

        const sendCommandOutput = async (line: string): Promise<void> => {
            try {
                const { response, text, images } = await this.messageHandler.ask("command_output", line)
                if (response !== "yesButtonClicked") {
                    userFeedback = { text, images }
                }
                didContinue = true
                process.continue()
            } catch {
                // This can only happen if this ask promise was ignored, so ignore this error
            }
        }

        process.on("line", (line) => {
            result += line + "\n"
            if (!didContinue) {
                sendCommandOutput(line)
            } else {
                this.messageHandler.say("command_output", line)
            }
        })

        let completed = false
        process.once("completed", () => {
            completed = true
        })

        process.once("no_shell_integration", async () => {
            await this.messageHandler.say("shell_integration_warning")
        })

        await process

        // Wait for a short delay to ensure all messages are sent to the webview
        await delay(50)

        result = result.trim()

        if (userFeedback) {
            await this.messageHandler.say("user_feedback", userFeedback.text, userFeedback.images)
            return {
                response: `Command is still running in the user's terminal.${
                    result.length > 0 ? `\nHere's the output so far:\n${result}` : ""
                }\n\nThe user provided the following feedback:\n<feedback>\n${userFeedback.text}\n</feedback>`,
                userRejected: true
            }
        }

        if (completed) {
            return {
                response: `Command executed.${result.length > 0 ? `\nOutput:\n${result}` : ""}`
            }
        } else {
            return {
                response: `Command is still running in the user's terminal.${
                    result.length > 0 ? `\nHere's the output so far:\n${result}` : ""
                }\n\nYou will be updated on the terminal status and new output in the future.`
            }
        }
    }
}
