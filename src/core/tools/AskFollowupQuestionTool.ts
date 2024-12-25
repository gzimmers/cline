import { Tool, ToolParams, ToolResult, ToolContext } from "./Tool"
import { ClineSayTool } from "../../shared/ExtensionMessage"
import { formatResponse } from "../prompts/responses"

interface AskFollowupQuestionParams extends ToolParams {
    question?: string
}

export class AskFollowupQuestionTool extends Tool<AskFollowupQuestionParams> {
    constructor(context: ToolContext) {
        super(context)
    }

    validateParams(params: AskFollowupQuestionParams): string | undefined {
        if (!params.question) return "question"
        return undefined
    }

    formatToolMessage(params: AskFollowupQuestionParams): ClineSayTool {
        return {
            tool: "searchFiles", // Using searchFiles as a base type since we just need a simple message format
            path: "",
            content: params.question
        }
    }

    async execute(params: AskFollowupQuestionParams): Promise<ToolResult> {
        return {
            response: formatResponse.toolResult(
                `<answer>\n${params.question}\n</answer>`,
                undefined
            )
        }
    }
}
