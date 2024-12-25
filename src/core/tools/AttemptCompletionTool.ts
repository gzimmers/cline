import { Tool, ToolParams, ToolResult, ToolContext } from "./Tool"
import { ClineSayTool } from "../../shared/ExtensionMessage"
import { formatResponse } from "../prompts/responses"

interface AttemptCompletionParams extends ToolParams {
    result?: string
    command?: string
}

export class AttemptCompletionTool extends Tool<AttemptCompletionParams> {
    constructor(context: ToolContext) {
        super(context)
    }

    validateParams(params: AttemptCompletionParams): string | undefined {
        if (!params.result) return "result"
        return undefined
    }

    formatToolMessage(params: AttemptCompletionParams): ClineSayTool {
        return {
            tool: "searchFiles", // Using searchFiles as a base type since we just need a simple message format
            path: "",
            content: JSON.stringify({
                result: params.result,
                command: params.command
            })
        }
    }

    async execute(params: AttemptCompletionParams): Promise<ToolResult> {
        // The actual execution of this tool is handled differently in the Cline class
        // as it requires special handling for completion results and optional commands
        return {
            response: params.result || "Task completed."
        }
    }
}
