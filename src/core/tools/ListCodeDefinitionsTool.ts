import { Tool, ToolParams, ToolResult, ToolContext } from "./Tool"
import { FileService } from "../services/FileService"
import { ClineSayTool } from "../../shared/ExtensionMessage"

interface ListCodeDefinitionsParams extends ToolParams {
    path?: string
}

export class ListCodeDefinitionsTool extends Tool<ListCodeDefinitionsParams> {
    private fileService: FileService

    constructor(context: ToolContext, fileService: FileService) {
        super(context)
        this.fileService = fileService
    }

    validateParams(params: ListCodeDefinitionsParams): string | undefined {
        if (!params.path) return "path"
        return undefined
    }

    formatToolMessage(params: ListCodeDefinitionsParams): ClineSayTool {
        return {
            tool: "listCodeDefinitionNames",
            path: this.fileService.getReadablePath(params.path || ""),
            content: ""
        }
    }

    async execute(params: ListCodeDefinitionsParams): Promise<ToolResult> {
        try {
            const result = await this.fileService.getCodeDefinitions(params.path!)
            return { response: result }
        } catch (error) {
            throw error
        }
    }
}
