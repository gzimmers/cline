import { Tool, ToolParams, ToolResult, ToolContext } from "./Tool"
import { FileService } from "../services/FileService"
import { ClineSayTool } from "../../shared/ExtensionMessage"

interface ListFilesParams extends ToolParams {
    path?: string
    recursive?: string
}

export class ListFilesTool extends Tool<ListFilesParams> {
    private fileService: FileService

    constructor(context: ToolContext, fileService: FileService) {
        super(context)
        this.fileService = fileService
    }

    validateParams(params: ListFilesParams): string | undefined {
        if (!params.path) return "path"
        return undefined
    }

    formatToolMessage(params: ListFilesParams): ClineSayTool {
        const recursive = params.recursive?.toLowerCase() === "true"
        return {
            tool: !recursive ? "listFilesTopLevel" : "listFilesRecursive",
            path: this.fileService.getReadablePath(params.path || ""),
            content: ""
        }
    }

    async execute(params: ListFilesParams): Promise<ToolResult> {
        const recursive = params.recursive?.toLowerCase() === "true"
        
        try {
            const { result, didHitLimit } = await this.fileService.listDirectoryFiles(params.path!, recursive)
            return { response: result }
        } catch (error) {
            throw error
        }
    }
}
