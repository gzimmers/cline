import { Anthropic } from "@anthropic-ai/sdk"
import { ClineSayTool } from "../../shared/ExtensionMessage"

export type ToolResponse = string | Array<Anthropic.TextBlockParam | Anthropic.ImageBlockParam>

export interface ToolParams {
    [key: string]: string | undefined
}

export interface ToolContext {
    cwd: string
    alwaysAllowReadOnly: boolean
}

export interface ToolResult {
    response: ToolResponse
    userRejected?: boolean
}

export abstract class Tool<T extends ToolParams> {
    protected context: ToolContext

    constructor(context: ToolContext) {
        this.context = context
    }

    abstract execute(params: T): Promise<ToolResult>
    abstract validateParams(params: T): string | undefined
    abstract formatToolMessage(params: T): ClineSayTool
}
