import { Tool, ToolParams, ToolResult, ToolContext } from "./Tool"
import { FileService } from "../services/FileService"
import { ClineSayTool } from "../../shared/ExtensionMessage"

interface SearchFilesParams extends ToolParams {
    path?: string
    regex?: string
    file_pattern?: string
}

export class SearchFilesTool extends Tool<SearchFilesParams> {
    private fileService: FileService

    constructor(context: ToolContext, fileService: FileService) {
        super(context)
        this.fileService = fileService
    }

    validateParams(params: SearchFilesParams): string | undefined {
        if (!params.path) return "path"
        if (!params.regex) return "regex"
        return undefined
    }

    formatToolMessage(params: SearchFilesParams): ClineSayTool {
        return {
            tool: "searchFiles",
            path: this.fileService.getReadablePath(params.path || ""),
            regex: params.regex,
            filePattern: params.file_pattern,
            content: ""
        }
    }

    async execute(params: SearchFilesParams): Promise<ToolResult> {
        try {
            const result = await this.fileService.searchFiles(
                params.path!,
                params.regex!,
                params.file_pattern
            )
            return { response: result }
        } catch (error) {
            throw error
        }
    }
}
