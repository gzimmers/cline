import { Tool, ToolParams, ToolResult, ToolContext } from "./Tool"
import { FileService } from "../services/FileService"
import { ClineSayTool } from "../../shared/ExtensionMessage"

interface ReadFileParams extends ToolParams {
    path?: string
}

export class ReadFileTool extends Tool<ReadFileParams> {
    private fileService: FileService

    constructor(context: ToolContext, fileService: FileService) {
        super(context)
        this.fileService = fileService
    }

    validateParams(params: ReadFileParams): string | undefined {
        if (!params.path) return "path"
        return undefined
    }

    formatToolMessage(params: ReadFileParams): ClineSayTool {
        return {
            tool: "readFile",
            path: this.fileService.getReadablePath(params.path || ""),
            content: params.path
        }
    }

    async execute(params: ReadFileParams): Promise<ToolResult> {
        if (this.context.alwaysAllowReadOnly) {
            const content = await this.fileService.readFile(params.path!)
            return { response: content }
        }

        try {
            const content = await this.fileService.readFile(params.path!)
            return { response: content }
        } catch (error) {
            throw error
        }
    }
}
