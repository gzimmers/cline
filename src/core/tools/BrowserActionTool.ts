import { Tool, ToolParams, ToolResult, ToolContext } from "./Tool"
import { BrowserService } from "../services/BrowserService"
import { BrowserAction, ClineSayTool } from "../../shared/ExtensionMessage"
import { formatResponse } from "../prompts/responses"

interface BrowserActionParams extends ToolParams {
    action?: BrowserAction
    url?: string
    coordinate?: string
    text?: string
}

export class BrowserActionTool extends Tool<BrowserActionParams> {
    private browserService: BrowserService

    constructor(context: ToolContext, browserService: BrowserService) {
        super(context)
        this.browserService = browserService
    }

    validateParams(params: BrowserActionParams): string | undefined {
        if (!params.action) return "action"
        
        switch (params.action) {
            case "launch":
                if (!params.url) return "url"
                break
            case "click":
                if (!params.coordinate) return "coordinate"
                break
            case "type":
                if (!params.text) return "text"
                break
        }
        
        return undefined
    }

    formatToolMessage(params: BrowserActionParams): ClineSayTool {
        // For browser actions, we'll use a generic tool type with additional action-specific properties
        return {
            tool: "searchFiles", // Using searchFiles as a base type since it supports all the properties we need
            path: params.url || "",
            content: JSON.stringify({
                action: params.action,
                coordinate: params.coordinate,
                text: params.text
            })
        }
    }

    async execute(params: BrowserActionParams): Promise<ToolResult> {
        try {
            let result;
            switch (params.action) {
                case "launch":
                    result = await this.browserService.launchBrowser(params.url!)
                    break
                case "click":
                    result = await this.browserService.click(params.coordinate!)
                    break
                case "type":
                    result = await this.browserService.type(params.text!)
                    break
                case "scroll_down":
                    result = await this.browserService.scrollDown()
                    break
                case "scroll_up":
                    result = await this.browserService.scrollUp()
                    break
                case "close":
                    result = await this.browserService.closeBrowser()
                    break
                default:
                    throw new Error(`Unknown browser action: ${params.action}`)
            }

            return {
                response: formatResponse.toolResult(
                    this.browserService.formatBrowserActionResult(result, params.action!),
                    result.screenshot ? [result.screenshot] : []
                )
            }
        } catch (error) {
            await this.browserService.closeBrowser()
            throw error
        }
    }
}
