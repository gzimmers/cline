import { Tool, ToolContext, ToolParams, ToolResult } from "./Tool"
import { formatResponse } from "../prompts/responses"
import { ClineAsk } from "../../shared/ExtensionMessage"
import { MessageHandler } from "../messages/MessageHandler"

export class ToolManager {
    private tools: Map<string, Tool<any>> = new Map()
    private messageHandler: MessageHandler
    private context: ToolContext
    private didRejectTool = false
    private didAlreadyUseTool = false

    constructor(messageHandler: MessageHandler, context: ToolContext) {
        this.messageHandler = messageHandler
        this.context = context
    }

    registerTool(name: string, tool: Tool<any>) {
        this.tools.set(name, tool)
    }

    reset() {
        this.didRejectTool = false
        this.didAlreadyUseTool = false
    }

    isToolRejected(): boolean {
        return this.didRejectTool
    }

    hasUsedTool(): boolean {
        return this.didAlreadyUseTool
    }

    private async askToolApproval(type: ClineAsk, partialMessage?: string): Promise<boolean> {
        const { response, text, images } = await this.messageHandler.ask(type, partialMessage, false)
        if (response !== "yesButtonClicked") {
            if (response === "messageResponse") {
                await this.messageHandler.say("user_feedback", text, images)
                return false
            }
            return false
        }
        return true
    }

    async executeTool(name: string, params: ToolParams): Promise<ToolResult> {
        if (this.didRejectTool) {
            return {
                response: `Skipping tool [${name}] due to user rejecting a previous tool.`,
                userRejected: true
            }
        }

        if (this.didAlreadyUseTool) {
            return {
                response: `Tool [${name}] was not executed because a tool has already been used in this message. Only one tool may be used per message. You must assess the first tool's result before proceeding to use the next tool.`,
                userRejected: true
            }
        }

        const tool = this.tools.get(name)
        if (!tool) {
            throw new Error(`Tool ${name} not found`)
        }

        const missingParam = tool.validateParams(params)
        if (missingParam) {
            return {
                response: formatResponse.toolError(formatResponse.missingToolParameterError(missingParam)),
                userRejected: true
            }
        }

        const toolMessage = tool.formatToolMessage(params)
        const didApprove = await this.askToolApproval("tool", JSON.stringify(toolMessage))
        if (!didApprove) {
            this.didRejectTool = true
            return {
                response: formatResponse.toolDenied(),
                userRejected: true
            }
        }

        try {
            const result = await tool.execute(params)
            if (result.userRejected) {
                this.didRejectTool = true
            } else {
                this.didAlreadyUseTool = true
            }
            return result
        } catch (error) {
            const errorMessage = `Error executing ${name}: ${error.message || JSON.stringify(error)}`
            await this.messageHandler.say("error", errorMessage)
            return {
                response: formatResponse.toolError(errorMessage),
                userRejected: true
            }
        }
    }
}
