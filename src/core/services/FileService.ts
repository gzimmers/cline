import * as vscode from "vscode"
import * as path from "path"
import * as fs from "fs/promises"
import { DiffViewProvider } from "../../integrations/editor/DiffViewProvider"
import { extractTextFromFile } from "../../integrations/misc/extract-text"
import { listFiles } from "../../services/glob/list-files"
import { regexSearchFiles } from "../../services/ripgrep"
import { parseSourceCodeForDefinitionsTopLevel } from "../../services/tree-sitter"
import { showOmissionWarning } from "../../integrations/editor/detect-omission"
import { formatResponse } from "../prompts/responses"
import { getReadablePath } from "../../utils/path"
import { fileExistsAtPath } from "../../utils/fs"
import delay from "delay"

export class FileService {
    private cwd: string
    private diffViewProvider: DiffViewProvider

    constructor(cwd: string) {
        this.cwd = cwd
        this.diffViewProvider = new DiffViewProvider(cwd)
    }

    async writeFile(relPath: string, content: string): Promise<{
        newProblemsMessage?: string
        userEdits?: string
        finalContent?: string
    }> {
        const absolutePath = path.resolve(this.cwd, relPath)
        const fileExists = await fileExistsAtPath(absolutePath)
        this.diffViewProvider.editType = fileExists ? "modify" : "create"

        if (!this.diffViewProvider.isEditing) {
            await this.diffViewProvider.open(relPath)
        }

        await this.diffViewProvider.update(content, true)
        await delay(300)
        this.diffViewProvider.scrollToFirstDiff()

        if (fileExists) {
            showOmissionWarning(this.diffViewProvider.originalContent || "", content)
        }

        const result = await this.diffViewProvider.saveChanges()
        await this.diffViewProvider.reset()
        return result
    }

    async readFile(relPath: string): Promise<string> {
        const absolutePath = path.resolve(this.cwd, relPath)
        return await extractTextFromFile(absolutePath)
    }

    async listDirectoryFiles(relDirPath: string, recursive: boolean = false): Promise<{
        result: string
        didHitLimit: boolean
    }> {
        const absolutePath = path.resolve(this.cwd, relDirPath)
        const [files, didHitLimit] = await listFiles(absolutePath, recursive, 200)
        const result = formatResponse.formatFilesList(absolutePath, files, didHitLimit)
        return { result, didHitLimit }
    }

    async searchFiles(relDirPath: string, regex: string, filePattern?: string): Promise<string> {
        const absolutePath = path.resolve(this.cwd, relDirPath)
        return await regexSearchFiles(this.cwd, absolutePath, regex, filePattern)
    }

    async getCodeDefinitions(relDirPath: string): Promise<string> {
        const absolutePath = path.resolve(this.cwd, relDirPath)
        return await parseSourceCodeForDefinitionsTopLevel(absolutePath)
    }

    async revertChanges(): Promise<void> {
        await this.diffViewProvider.revertChanges()
    }

    async reset(): Promise<void> {
        await this.diffViewProvider.reset()
    }

    isEditing(): boolean {
        return this.diffViewProvider.isEditing
    }

    getReadablePath(relPath: string): string {
        return getReadablePath(this.cwd, relPath)
    }
}
