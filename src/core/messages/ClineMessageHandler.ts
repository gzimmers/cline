import * as vscode from "vscode"
import * as path from "path"
import * as fs from "fs/promises"
import { ClineAsk, ClineSay, ClineMessage } from "../../shared/ExtensionMessage"
import { MessageHandler, AskResponse } from "./MessageHandler"
import { ClineProvider, GlobalFileNames } from "../webview/ClineProvider"
import { findLastIndex } from "../../shared/array"
import pWaitFor from "p-wait-for"

export class ClineMessageHandler implements MessageHandler {
    private taskId: string
    private clineMessages: ClineMessage[] = []
    private askResponse?: AskResponse
    private askResponseText?: string
    private askResponseImages?: string[]
    private lastMessageTs?: number
    private providerRef: WeakRef<ClineProvider>

    constructor(provider: ClineProvider, taskId: string) {
        this.providerRef = new WeakRef(provider)
        this.taskId = taskId
    }

    async ask(type: ClineAsk, text?: string, partial?: boolean): Promise<AskResponse> {
        let askTs: number
        if (partial !== undefined) {
            const lastMessage = this.clineMessages.at(-1)
            const isUpdatingPreviousPartial = lastMessage && 
                lastMessage.partial && 
                lastMessage.type === "ask" && 
                lastMessage.ask === type

            if (partial) {
                if (isUpdatingPreviousPartial) {
                    lastMessage.text = text
                    lastMessage.partial = partial
                    await this.providerRef.deref()?.postMessageToWebview({ 
                        type: "partialMessage", 
                        partialMessage: lastMessage 
                    })
                    throw new Error("Current ask promise was ignored")
                } else {
                    askTs = Date.now()
                    this.lastMessageTs = askTs
                    await this.addToClineMessages({ ts: askTs, type: "ask", ask: type, text, partial })
                    await this.providerRef.deref()?.postStateToWebview()
                    throw new Error("Current ask promise was ignored")
                }
            } else {
                if (isUpdatingPreviousPartial) {
                    askTs = lastMessage.ts
                    this.lastMessageTs = askTs
                    lastMessage.text = text
                    lastMessage.partial = false
                    await this.saveClineMessages()
                    await this.providerRef.deref()?.postMessageToWebview({ 
                        type: "partialMessage", 
                        partialMessage: lastMessage 
                    })
                } else {
                    askTs = Date.now()
                    this.lastMessageTs = askTs
                    await this.addToClineMessages({ ts: askTs, type: "ask", ask: type, text })
                    await this.providerRef.deref()?.postStateToWebview()
                }
            }
        } else {
            askTs = Date.now()
            this.lastMessageTs = askTs
            await this.addToClineMessages({ ts: askTs, type: "ask", ask: type, text })
            await this.providerRef.deref()?.postStateToWebview()
        }

        await pWaitFor(() => this.askResponse !== undefined || this.lastMessageTs !== askTs, { interval: 100 })
        if (this.lastMessageTs !== askTs) {
            throw new Error("Current ask promise was ignored")
        }

        const result = { 
            response: this.askResponse!.response, 
            text: this.askResponseText, 
            images: this.askResponseImages 
        }
        this.askResponse = undefined
        this.askResponseText = undefined
        this.askResponseImages = undefined
        return result
    }

    async say(type: ClineSay, text?: string, images?: string[], partial?: boolean): Promise<void> {
        if (partial !== undefined) {
            const lastMessage = this.clineMessages.at(-1)
            const isUpdatingPreviousPartial = lastMessage && 
                lastMessage.partial && 
                lastMessage.type === "say" && 
                lastMessage.say === type

            if (partial) {
                if (isUpdatingPreviousPartial) {
                    lastMessage.text = text
                    lastMessage.images = images
                    lastMessage.partial = partial
                    await this.providerRef.deref()?.postMessageToWebview({ 
                        type: "partialMessage", 
                        partialMessage: lastMessage 
                    })
                } else {
                    const sayTs = Date.now()
                    this.lastMessageTs = sayTs
                    await this.addToClineMessages({ ts: sayTs, type: "say", say: type, text, images, partial })
                    await this.providerRef.deref()?.postStateToWebview()
                }
            } else {
                if (isUpdatingPreviousPartial) {
                    this.lastMessageTs = lastMessage.ts
                    lastMessage.text = text
                    lastMessage.images = images
                    lastMessage.partial = false
                    await this.saveClineMessages()
                    await this.providerRef.deref()?.postMessageToWebview({ 
                        type: "partialMessage", 
                        partialMessage: lastMessage 
                    })
                } else {
                    const sayTs = Date.now()
                    this.lastMessageTs = sayTs
                    await this.addToClineMessages({ ts: sayTs, type: "say", say: type, text, images })
                    await this.providerRef.deref()?.postStateToWebview()
                }
            }
        } else {
            const sayTs = Date.now()
            this.lastMessageTs = sayTs
            await this.addToClineMessages({ ts: sayTs, type: "say", say: type, text, images })
            await this.providerRef.deref()?.postStateToWebview()
        }
    }

    async handleWebviewAskResponse(askResponse: AskResponse, text?: string, images?: string[]) {
        this.askResponse = askResponse
        this.askResponseText = text
        this.askResponseImages = images
    }

    private async ensureTaskDirectoryExists(): Promise<string> {
        const globalStoragePath = this.providerRef.deref()?.context.globalStorageUri.fsPath
        if (!globalStoragePath) {
            throw new Error("Global storage uri is invalid")
        }
        const taskDir = path.join(globalStoragePath, "tasks", this.taskId)
        await fs.mkdir(taskDir, { recursive: true })
        return taskDir
    }

    private async addToClineMessages(message: ClineMessage) {
        this.clineMessages.push(message)
        await this.saveClineMessages()
    }

    async getClineMessages(): Promise<ClineMessage[]> {
        return this.clineMessages
    }

    private async saveClineMessages() {
        try {
            const filePath = path.join(await this.ensureTaskDirectoryExists(), GlobalFileNames.uiMessages)
            await fs.writeFile(filePath, JSON.stringify(this.clineMessages))
            await this.providerRef.deref()?.updateTaskHistory({
                id: this.taskId,
                ts: this.clineMessages[this.clineMessages.length - 1].ts,
                task: this.clineMessages[0].text ?? "",
                tokensIn: 0, // These would need to be calculated and passed in
                tokensOut: 0,
                cacheWrites: 0,
                cacheReads: 0,
                totalCost: 0,
            })
        } catch (error) {
            console.error("Failed to save cline messages:", error)
        }
    }
}
