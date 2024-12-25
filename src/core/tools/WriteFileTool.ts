import { Tool, ToolParams, ToolResult, ToolContext } from "./Tool"
import { FileService } from "../services/FileService"
import { ClineSayTool } from "../../shared/ExtensionMessage"
import { formatResponse } from "../prompts/responses"

interface WriteFileParams extends ToolParams {
    path?: string
    content?: string
}

export class WriteFileTool extends Tool<WriteFileParams> {
    private fileService: FileService

    constructor(context: ToolContext, fileService: FileService) {
        super(context)
        this.fileService = fileService
    }

    validateParams(params: WriteFileParams): string | undefined {
        if (!params.path) return "path"
        if (!params.content) return "content"
        return undefined
    }

    formatToolMessage(params: WriteFileParams): ClineSayTool {
        const fileExists = this.fileService.isEditing()
        return {
            tool: fileExists ? "editedExistingFile" : "newFileCreated",
            path: this.fileService.getReadablePath(params.path || ""),
            content: !fileExists ? params.content : undefined,
            diff: fileExists && params.content ? formatResponse.createPrettyPatch(
                params.path || "",
                this.fileService.isEditing() ? "" : params.content || "",
                params.content
            ) : undefined,
        }
    }

    async execute(params: WriteFileParams): Promise<ToolResult> {
        try {
            const result = await this.fileService.writeFile(params.path!, params.content!)
            
            if (result.userEdits) {
                const response = `The user made the following updates to your content:\n\n${result.userEdits}\n\n` +
                    `The updated content, which includes both your original modifications and the user's edits, has been successfully saved to ${params.path}. Here is the full, updated content of the file:\n\n` +
                    `<final_file_content path="${params.path}">\n${result.finalContent}\n</final_file_content>\n\n` +
                    `Please note:\n` +
                    `1. You do not need to re-write the file with these changes, as they have already been applied.\n` +
                    `2. Proceed with the task using this updated file content as the new baseline.\n` +
                    `3. If the user's edits have addressed part of the task or changed the requirements, adjust your approach accordingly.` +
                    `${result.newProblemsMessage || ""}`

                return { response }
            }

            return {
                response: `The content was successfully saved to ${params.path}.${result.newProblemsMessage || ""}`
            }
        } catch (error) {
            await this.fileService.revertChanges()
            throw error
        }
    }
}
