import { Anthropic } from "@anthropic-ai/sdk"
import cloneDeep from "clone-deep"
import * as path from "path"
import * as vscode from "vscode"
import { ApiHandler, buildApiHandler } from "../api"
import { ApiConfiguration } from "../shared/api"
import { ClineMessage, ClineAsk, ClineApiReqInfo, ClineApiReqCancelReason } from "../shared/ExtensionMessage"
import { HistoryItem } from "../shared/HistoryItem"
import { ClineProvider } from "./webview/ClineProvider"
import { parseMentions } from "./mentions"
import { parseAssistantMessage, AssistantMessageContent } from "./assistant-message"
import { SYSTEM_PROMPT, addCustomInstructions } from "./prompts/system"
import { truncateHalfConversation } from "./sliding-window"
import { findLastIndex } from "../shared/array"
import pWaitFor from "p-wait-for"
import { serializeError } from "serialize-error"
import { TerminalManager } from "../integrations/terminal/TerminalManager"
import { UrlContentFetcher } from "../services/browser/UrlContentFetcher"
import { formatResponse } from "./prompts/responses"
import { ApiStream } from "../api/transform/stream"
import { calculateApiCost } from "../utils/cost"
import { formatContentBlockToMarkdown } from "../integrations/misc/export-markdown"

import {
    ToolManager,
    WriteFileTool,
    ReadFileTool,
    ListFilesTool,
    SearchFilesTool,
    ListCodeDefinitionsTool,
    BrowserActionTool,
    AskFollowupQuestionTool,
    AttemptCompletionTool,
    ExecuteCommandTool,
    ToolContext
} from "./tools"
import { FileService } from "./services/FileService"
import { BrowserService } from "./services/BrowserService"
import { ClineMessageHandler } from "./messages/ClineMessageHandler"
import { MessageHandler } from "./messages/MessageHandler"

type UserContent = Array<
    Anthropic.TextBlockParam | Anthropic.ImageBlockParam | Anthropic.ToolUseBlockParam | Anthropic.ToolResultBlockParam
>

export class Cline {
    readonly taskId: string
    private api: ApiHandler
    private messageHandler: MessageHandler
    private toolManager: ToolManager
    private fileService: FileService
    private browserService: BrowserService
    private terminalManager: TerminalManager
    private urlContentFetcher: UrlContentFetcher
    private customInstructions?: string
    private alwaysAllowReadOnly: boolean
    private apiConversationHistory: Anthropic.MessageParam[] = []
    private consecutiveMistakeCount: number = 0
    private providerRef: WeakRef<ClineProvider>
    private abort: boolean = false
    didFinishAborting = false
    abandoned = false
    private didEditFile: boolean = false
    private context: { cwd: string }

    // streaming state
    private currentStreamingContentIndex = 0
    private assistantMessageContent: AssistantMessageContent[] = []
    private presentAssistantMessageLocked = false
    private presentAssistantMessageHasPendingUpdates = false
    private userMessageContent: UserContent = []
    private userMessageContentReady = false
    private didCompleteReadingStream = false

    constructor(
        provider: ClineProvider,
        apiConfiguration: ApiConfiguration,
        customInstructions?: string,
        alwaysAllowReadOnly?: boolean,
        task?: string,
        images?: string[],
        historyItem?: HistoryItem
    ) {
        this.taskId = historyItem?.id || Date.now().toString()
        this.providerRef = new WeakRef(provider)
        this.api = buildApiHandler(apiConfiguration)
        this.customInstructions = customInstructions
        this.alwaysAllowReadOnly = alwaysAllowReadOnly ?? false
        this.context = { cwd: provider.context.globalStorageUri.fsPath }

        // Initialize services
        this.terminalManager = new TerminalManager()
        this.urlContentFetcher = new UrlContentFetcher(provider.context)
        this.fileService = new FileService(this.context.cwd)
        this.browserService = new BrowserService(provider.context)
        this.messageHandler = new ClineMessageHandler(provider, this.taskId)

        // Initialize tool context
        const toolContext: ToolContext = {
            cwd: this.context.cwd,
            alwaysAllowReadOnly: this.alwaysAllowReadOnly
        }

        // Initialize tool manager and register tools
        this.toolManager = new ToolManager(this.messageHandler, toolContext)
        this.initializeTools(toolContext)

        if (historyItem) {
            void this.resumeTaskFromHistory()
        } else if (task || images) {
            void this.startTask(task, images)
        } else {
            throw new Error("Either historyItem or task/images must be provided")
        }
    }

    private initializeTools(toolContext: ToolContext): void {
        this.toolManager.registerTool("write_to_file", new WriteFileTool(toolContext, this.fileService))
        this.toolManager.registerTool("read_file", new ReadFileTool(toolContext, this.fileService))
        this.toolManager.registerTool("list_files", new ListFilesTool(toolContext, this.fileService))
        this.toolManager.registerTool("search_files", new SearchFilesTool(toolContext, this.fileService))
        this.toolManager.registerTool("list_code_definition_names", new ListCodeDefinitionsTool(toolContext, this.fileService))
        this.toolManager.registerTool("browser_action", new BrowserActionTool(toolContext, this.browserService))
        this.toolManager.registerTool("ask_followup_question", new AskFollowupQuestionTool(toolContext))
        this.toolManager.registerTool("attempt_completion", new AttemptCompletionTool(toolContext))
        this.toolManager.registerTool("execute_command", new ExecuteCommandTool(toolContext, this.terminalManager, this.messageHandler))
    }

    private async startTask(task?: string, images?: string[]): Promise<void> {
        await this.messageHandler.say("text", task, images)

        let imageBlocks: Anthropic.ImageBlockParam[] = images?.map(image => ({
            type: "image",
            source: {
                type: "base64",
                media_type: "image/png",
                data: image
            }
        })) || []

        await this.initiateTaskLoop([
            {
                type: "text",
                text: `<task>\n${task}\n</task>`,
            },
            ...imageBlocks,
        ])
    }

    private async resumeTaskFromHistory(): Promise<void> {
        // Implementation remains similar but uses messageHandler instead of direct message handling
        // ... (implementation details)
        return Promise.resolve()
    }

    private async initiateTaskLoop(userContent: UserContent): Promise<void> {
        let nextUserContent = userContent
        let includeFileDetails = true
        while (!this.abort) {
            const didEndLoop = await this.recursivelyMakeClineRequests(nextUserContent, includeFileDetails)
            includeFileDetails = false

            if (didEndLoop) {
                break
            } else {
                nextUserContent = [
                    {
                        type: "text",
                        text: formatResponse.noToolsUsed(),
                    },
                ]
                this.consecutiveMistakeCount++
            }
        }
    }

    private getMessageContent(block: AssistantMessageContent): string {
        if (block.type === "text") {
            return block.content
        } else {
            // For tool_use, convert params to string
            return Object.entries(block.params)
                .map(([key, value]) => `${key}: ${value}`)
                .join("\n")
        }
    }

    private async updateMessages(messages: ClineMessage[]): Promise<void> {
        await this.messageHandler.say("text", JSON.stringify(messages))
        await this.providerRef.deref()?.postStateToWebview()
    }

    private async recursivelyMakeClineRequests(
        userContent: UserContent,
        includeFileDetails: boolean = false
    ): Promise<boolean> {
        if (this.abort) {
            throw new Error("Cline instance aborted")
        }

        // Get previous api req's index to check token usage
        const previousApiReqIndex = findLastIndex(
            await (this.messageHandler as ClineMessageHandler).getClineMessages(),
            (m) => m.say === "api_req_started"
        )

        // Show loading state while preparing context
        await this.messageHandler.say(
            "api_req_started",
            JSON.stringify({
                request: userContent.map((block) => formatContentBlockToMarkdown(block)).join("\n\n") + "\n\nLoading...",
            } as ClineApiReqInfo)
        )

        // Process user content and get environment details
        const [parsedUserContent, environmentDetails] = await this.loadContext(userContent, includeFileDetails)
        userContent = parsedUserContent
        userContent.push({ type: "text", text: environmentDetails })

        await this.addToApiConversationHistory({ role: "user", content: userContent })

        try {
            let inputTokens = 0
            let outputTokens = 0
            let cacheWriteTokens = 0
            let cacheReadTokens = 0
            let totalCost: number | undefined

            const updateApiReqMsg = async (cancelReason?: ClineApiReqCancelReason, streamingFailedMessage?: string) => {
                const messages = await (this.messageHandler as ClineMessageHandler).getClineMessages()
                const lastApiReqIndex = findLastIndex(messages, (m) => m.say === "api_req_started")
                if (lastApiReqIndex !== -1) {
                    messages[lastApiReqIndex].text = JSON.stringify({
                        ...JSON.parse(messages[lastApiReqIndex].text || "{}"),
                        tokensIn: inputTokens,
                        tokensOut: outputTokens,
                        cacheWrites: cacheWriteTokens,
                        cacheReads: cacheReadTokens,
                        cost: totalCost ?? calculateApiCost(
                            this.api.getModel().info,
                            inputTokens,
                            outputTokens,
                            cacheWriteTokens,
                            cacheReadTokens
                        ),
                        cancelReason,
                        streamingFailedMessage,
                    } as ClineApiReqInfo)
                    await this.updateMessages(messages)
                }
            }

            // Reset streaming state
            this.currentStreamingContentIndex = 0
            this.assistantMessageContent = []
            this.didCompleteReadingStream = false
            this.userMessageContent = []
            this.userMessageContentReady = false
            this.toolManager.reset()
            this.presentAssistantMessageLocked = false
            this.presentAssistantMessageHasPendingUpdates = false

            const stream = await this.createApiStream(previousApiReqIndex)
            let assistantMessage = ""

            try {
                for await (const chunk of stream) {
                    switch (chunk.type) {
                        case "usage":
                            inputTokens += chunk.inputTokens
                            outputTokens += chunk.outputTokens
                            cacheWriteTokens += chunk.cacheWriteTokens ?? 0
                            cacheReadTokens += chunk.cacheReadTokens ?? 0
                            totalCost = chunk.totalCost
                            break
                        case "text":
                            assistantMessage += chunk.text
                            const prevLength = this.assistantMessageContent.length
                            this.assistantMessageContent = parseAssistantMessage(assistantMessage)
                            if (this.assistantMessageContent.length > prevLength) {
                                this.userMessageContentReady = false
                            }
                            await this.presentAssistantMessage()
                            break
                    }

                    if (this.abort) {
                        if (!this.abandoned) {
                            await this.handleStreamAbort("user_cancelled")
                        }
                        break
                    }

                    if (this.toolManager.isToolRejected() || this.toolManager.hasUsedTool()) {
                        break
                    }
                }
            } catch (error) {
                if (!this.abandoned) {
                    this.abortTask()
                    await this.handleStreamAbort(
                        "streaming_failed",
                        error.message ?? JSON.stringify(serializeError(error), null, 2)
                    )
                    const history = await this.providerRef.deref()?.getTaskWithId(this.taskId)
                    if (history) {
                        await this.providerRef.deref()?.initClineWithHistoryItem(history.historyItem)
                    }
                }
            }

            if (this.abort) {
                throw new Error("Cline instance aborted")
            }

            this.didCompleteReadingStream = true

            // Complete any remaining partial blocks
            const partialBlocks = this.assistantMessageContent.filter((block) => block.partial)
            partialBlocks.forEach((block) => {
                block.partial = false
            })
            if (partialBlocks.length > 0) {
                await this.presentAssistantMessage()
            }

            await updateApiReqMsg()

            let didEndLoop = false
            if (assistantMessage.length > 0) {
                await this.addToApiConversationHistory({
                    role: "assistant",
                    content: [{ type: "text", text: assistantMessage }],
                })

                await pWaitFor(() => this.userMessageContentReady)

                const didToolUse = this.assistantMessageContent.some((block) => block.type === "tool_use")
                if (!didToolUse) {
                    this.userMessageContent.push({
                        type: "text",
                        text: formatResponse.noToolsUsed(),
                    })
                    this.consecutiveMistakeCount++
                }

                didEndLoop = await this.recursivelyMakeClineRequests(this.userMessageContent)
            } else {
                await this.messageHandler.say(
                    "error",
                    "Unexpected API Response: The language model did not provide any assistant messages."
                )
                await this.addToApiConversationHistory({
                    role: "assistant",
                    content: [{ type: "text", text: "Failure: I did not provide a response." }],
                })
            }

            return didEndLoop
        } catch (error) {
            return true
        }
    }

    private async createApiStream(previousApiReqIndex: number): Promise<ApiStream> {
        let systemPrompt = await SYSTEM_PROMPT(this.context.cwd, this.api.getModel().info.supportsComputerUse ?? false)
        if (this.customInstructions?.trim()) {
            systemPrompt += addCustomInstructions(this.customInstructions)
        }

        // Check if we need to truncate conversation history
        if (previousApiReqIndex >= 0) {
            const messages = await (this.messageHandler as ClineMessageHandler).getClineMessages()
            const previousRequest = messages[previousApiReqIndex]
            if (previousRequest?.text) {
                const { tokensIn, tokensOut, cacheWrites, cacheReads }: ClineApiReqInfo = JSON.parse(
                    previousRequest.text
                )
                const totalTokens = (tokensIn || 0) + (tokensOut || 0) + (cacheWrites || 0) + (cacheReads || 0)
                const contextWindow = this.api.getModel().info.contextWindow || 128_000
                const maxAllowedSize = Math.max(contextWindow - 40_000, contextWindow * 0.8)
                if (totalTokens >= maxAllowedSize) {
                    const truncatedMessages = truncateHalfConversation(this.apiConversationHistory)
                    await this.overwriteApiConversationHistory(truncatedMessages)
                }
            }
        }

        return this.api.createMessage(systemPrompt, this.apiConversationHistory)
    }

    private async handleStreamAbort(
        cancelReason: ClineApiReqCancelReason,
        streamingFailedMessage?: string
    ): Promise<void> {
        const messages = await (this.messageHandler as ClineMessageHandler).getClineMessages()
        const lastMessage = messages.at(-1)
        if (lastMessage?.partial) {
            lastMessage.partial = false
            await this.updateMessages(messages)
        }

        await this.addToApiConversationHistory({
            role: "assistant",
            content: [
                {
                    type: "text",
                    text: this.assistantMessageContent.map(block => this.getMessageContent(block)).join("") +
                        `\n\n[${
                            cancelReason === "streaming_failed"
                                ? "Response interrupted by API Error"
                                : "Response interrupted by user"
                        }]`,
                },
            ],
        })

        const lastApiReqIndex = findLastIndex(messages, (m) => m.say === "api_req_started")
        if (lastApiReqIndex !== -1) {
            messages[lastApiReqIndex].text = JSON.stringify({
                ...JSON.parse(messages[lastApiReqIndex].text || "{}"),
                cancelReason,
                streamingFailedMessage,
            } as ClineApiReqInfo)
            await this.updateMessages(messages)
        }

        this.didFinishAborting = true
    }

    async presentAssistantMessage() {
		if (this.abort) {
			throw new Error("Cline instance aborted")
		}

		if (this.presentAssistantMessageLocked) {
			this.presentAssistantMessageHasPendingUpdates = true
			return
		}
		this.presentAssistantMessageLocked = true
		this.presentAssistantMessageHasPendingUpdates = false

		if (this.currentStreamingContentIndex >= this.assistantMessageContent.length) {
			// this may happen if the last content block was completed before streaming could finish. if streaming is finished, and we're out of bounds then this means we already presented/executed the last content block and are ready to continue to next request
			if (this.didCompleteReadingStream) {
				this.userMessageContentReady = true
			}
			// console.log("no more content blocks to stream! this shouldn't happen?")
			this.presentAssistantMessageLocked = false
			return
			//throw new Error("No more content blocks to stream! This shouldn't happen...") // remove and just return after testing
		}

		const block = cloneDeep(this.assistantMessageContent[this.currentStreamingContentIndex]) // need to create copy bc while stream is updating the array, it could be updating the reference block properties too
		switch (block.type) {
			case "text": {
				if (this.didRejectTool || this.didAlreadyUseTool) {
					break
				}
				let content = block.content
				if (content) {
					// (have to do this for partial and complete since sending content in thinking tags to markdown renderer will automatically be removed)
					// Remove end substrings of <thinking or </thinking (below xml parsing is only for opening tags)
					// (this is done with the xml parsing below now, but keeping here for reference)
					// content = content.replace(/<\/?t(?:h(?:i(?:n(?:k(?:i(?:n(?:g)?)?)?)?)?)?)?$/, "")
					// Remove all instances of <thinking> (with optional line break after) and </thinking> (with optional line break before)
					// - Needs to be separate since we dont want to remove the line break before the first tag
					// - Needs to happen before the xml parsing below
					content = content.replace(/<thinking>\s?/g, "")
					content = content.replace(/\s?<\/thinking>/g, "")

					// Remove partial XML tag at the very end of the content (for tool use and thinking tags)
					// (prevents scrollview from jumping when tags are automatically removed)
					const lastOpenBracketIndex = content.lastIndexOf("<")
					if (lastOpenBracketIndex !== -1) {
						const possibleTag = content.slice(lastOpenBracketIndex)
						// Check if there's a '>' after the last '<' (i.e., if the tag is complete) (complete thinking and tool tags will have been removed by now)
						const hasCloseBracket = possibleTag.includes(">")
						if (!hasCloseBracket) {
							// Extract the potential tag name
							let tagContent: string
							if (possibleTag.startsWith("</")) {
								tagContent = possibleTag.slice(2).trim()
							} else {
								tagContent = possibleTag.slice(1).trim()
							}
							// Check if tagContent is likely an incomplete tag name (letters and underscores only)
							const isLikelyTagName = /^[a-zA-Z_]+$/.test(tagContent)
							// Preemptively remove < or </ to keep from these artifacts showing up in chat (also handles closing thinking tags)
							const isOpeningOrClosing = possibleTag === "<" || possibleTag === "</"
							// If the tag is incomplete and at the end, remove it from the content
							if (isOpeningOrClosing || isLikelyTagName) {
								content = content.slice(0, lastOpenBracketIndex).trim()
							}
						}
					}
				}
				await this.say("text", content, undefined, block.partial)
				break
			}
			case "tool_use":
				const toolDescription = () => {
					switch (block.name) {
						case "execute_command":
							return `[${block.name} for '${block.params.command}']`
						case "read_file":
							return `[${block.name} for '${block.params.path}']`
						case "write_to_file":
							return `[${block.name} for '${block.params.path}']`
						case "search_files":
							return `[${block.name} for '${block.params.regex}'${
								block.params.file_pattern ? ` in '${block.params.file_pattern}'` : ""
							}]`
						case "list_files":
							return `[${block.name} for '${block.params.path}']`
						case "list_code_definition_names":
							return `[${block.name} for '${block.params.path}']`
						case "browser_action":
							return `[${block.name} for '${block.params.action}']`
						case "ask_followup_question":
							return `[${block.name} for '${block.params.question}']`
						case "attempt_completion":
							return `[${block.name}]`
					}
				}

				if (this.didRejectTool) {
					// ignore any tool content after user has rejected tool once
					if (!block.partial) {
						this.userMessageContent.push({
							type: "text",
							text: `Skipping tool ${toolDescription()} due to user rejecting a previous tool.`,
						})
					} else {
						// partial tool after user rejected a previous tool
						this.userMessageContent.push({
							type: "text",
							text: `Tool ${toolDescription()} was interrupted and not executed due to user rejecting a previous tool.`,
						})
					}
					break
				}

				if (this.didAlreadyUseTool) {
					// ignore any content after a tool has already been used
					this.userMessageContent.push({
						type: "text",
						text: `Tool [${block.name}] was not executed because a tool has already been used in this message. Only one tool may be used per message. You must assess the first tool's result before proceeding to use the next tool.`,
					})
					break
				}

				const pushToolResult = (content: ToolResponse) => {
					this.userMessageContent.push({
						type: "text",
						text: `${toolDescription()} Result:`,
					})
					if (typeof content === "string") {
						this.userMessageContent.push({
							type: "text",
							text: content || "(tool did not return anything)",
						})
					} else {
						this.userMessageContent.push(...content)
					}
					// once a tool result has been collected, ignore all other tool uses since we should only ever present one tool result per message
					this.didAlreadyUseTool = true
				}

				const askApproval = async (type: ClineAsk, partialMessage?: string) => {
					const { response, text, images } = await this.ask(type, partialMessage, false)
					if (response !== "yesButtonClicked") {
						if (response === "messageResponse") {
							await this.say("user_feedback", text, images)
							pushToolResult(
								formatResponse.toolResult(formatResponse.toolDeniedWithFeedback(text), images)
							)
							// this.userMessageContent.push({
							// 	type: "text",
							// 	text: `${toolDescription()}`,
							// })
							// this.toolResults.push({
							// 	type: "tool_result",
							// 	tool_use_id: toolUseId,
							// 	content: this.formatToolResponseWithImages(
							// 		await this.formatToolDeniedFeedback(text),
							// 		images
							// 	),
							// })
							this.didRejectTool = true
							return false
						}
						pushToolResult(formatResponse.toolDenied())
						// this.toolResults.push({
						// 	type: "tool_result",
						// 	tool_use_id: toolUseId,
						// 	content: await this.formatToolDenied(),
						// })
						this.didRejectTool = true
						return false
					}
					return true
				}

				const handleError = async (action: string, error: Error) => {
					const errorString = `Error ${action}: ${JSON.stringify(serializeError(error))}`
					await this.say(
						"error",
						`Error ${action}:\n${error.message ?? JSON.stringify(serializeError(error), null, 2)}`
					)
					// this.toolResults.push({
					// 	type: "tool_result",
					// 	tool_use_id: toolUseId,
					// 	content: await this.formatToolError(errorString),
					// })
					pushToolResult(formatResponse.toolError(errorString))
				}

				// If block is partial, remove partial closing tag so its not presented to user
				const removeClosingTag = (tag: ToolParamName, text?: string) => {
					if (!block.partial) {
						return text || ""
					}
					if (!text) {
						return ""
					}
					// This regex dynamically constructs a pattern to match the closing tag:
					// - Optionally matches whitespace before the tag
					// - Matches '<' or '</' optionally followed by any subset of characters from the tag name
					const tagRegex = new RegExp(
						`\\s?<\/?${tag
							.split("")
							.map((char) => `(?:${char})?`)
							.join("")}$`,
						"g"
					)
					return text.replace(tagRegex, "")
				}

				if (block.name !== "browser_action") {
					await this.browserSession.closeBrowser()
				}

				switch (block.name) {
					case "write_to_file": {
						const relPath: string | undefined = block.params.path
						let newContent: string | undefined = block.params.content
						if (!relPath || !newContent) {
							// checking for newContent ensure relPath is complete
							// wait so we can determine if it's a new file or editing an existing file
							break
						}
						// Check if file exists using cached map or fs.access
						let fileExists: boolean
						if (this.diffViewProvider.editType !== undefined) {
							fileExists = this.diffViewProvider.editType === "modify"
						} else {
							const absolutePath = path.resolve(cwd, relPath)
							fileExists = await fileExistsAtPath(absolutePath)
							this.diffViewProvider.editType = fileExists ? "modify" : "create"
						}

						// pre-processing newContent for cases where weaker models might add artifacts like markdown codeblock markers (deepseek/llama) or extra escape characters (gemini)
						if (newContent.startsWith("```")) {
							// this handles cases where it includes language specifiers like ```python ```js
							newContent = newContent.split("\n").slice(1).join("\n").trim()
						}
						if (newContent.endsWith("```")) {
							newContent = newContent.split("\n").slice(0, -1).join("\n").trim()
						}

						if (!this.api.getModel().id.includes("claude")) {
							// it seems not just llama models are doing this, but also gemini and potentially others
							if (
								newContent.includes("&gt;") ||
								newContent.includes("&lt;") ||
								newContent.includes("&quot;")
							) {
								newContent = newContent
									.replace(/&gt;/g, ">")
									.replace(/&lt;/g, "<")
									.replace(/&quot;/g, '"')
							}
						}

						const sharedMessageProps: ClineSayTool = {
							tool: fileExists ? "editedExistingFile" : "newFileCreated",
							path: getReadablePath(cwd, removeClosingTag("path", relPath)),
						}
						try {
							if (block.partial) {
								// update gui message
								const partialMessage = JSON.stringify(sharedMessageProps)
								await this.ask("tool", partialMessage, block.partial).catch(() => {})
								// update editor
								if (!this.diffViewProvider.isEditing) {
									// open the editor and prepare to stream content in
									await this.diffViewProvider.open(relPath)
								}
								// editor is open, stream content in
								await this.diffViewProvider.update(newContent, false)
								break
							} else {
								if (!relPath) {
									this.consecutiveMistakeCount++
									pushToolResult(await this.sayAndCreateMissingParamError("write_to_file", "path"))
									await this.diffViewProvider.reset()
									break
								}
								if (!newContent) {
									this.consecutiveMistakeCount++
									pushToolResult(await this.sayAndCreateMissingParamError("write_to_file", "content"))
									await this.diffViewProvider.reset()
									break
								}
								this.consecutiveMistakeCount = 0

								// if isEditingFile false, that means we have the full contents of the file already.
								// it's important to note how this function works, you can't make the assumption that the block.partial conditional will always be called since it may immediately get complete, non-partial data. So this part of the logic will always be called.
								// in other words, you must always repeat the block.partial logic here
								if (!this.diffViewProvider.isEditing) {
									// show gui message before showing edit animation
									const partialMessage = JSON.stringify(sharedMessageProps)
									await this.ask("tool", partialMessage, true).catch(() => {}) // sending true for partial even though it's not a partial, this shows the edit row before the content is streamed into the editor
									await this.diffViewProvider.open(relPath)
								}
								await this.diffViewProvider.update(newContent, true)
								await delay(300) // wait for diff view to update
								this.diffViewProvider.scrollToFirstDiff()
								showOmissionWarning(this.diffViewProvider.originalContent || "", newContent)

								const completeMessage = JSON.stringify({
									...sharedMessageProps,
									content: fileExists ? undefined : newContent,
									diff: fileExists
										? formatResponse.createPrettyPatch(
												relPath,
												this.diffViewProvider.originalContent,
												newContent
										  )
										: undefined,
								} satisfies ClineSayTool)
								const didApprove = await askApproval("tool", completeMessage)
								if (!didApprove) {
									await this.diffViewProvider.revertChanges()
									break
								}
								const { newProblemsMessage, userEdits, finalContent } =
									await this.diffViewProvider.saveChanges()
								this.didEditFile = true // used to determine if we should wait for busy terminal to update before sending api request
								if (userEdits) {
									await this.say(
										"user_feedback_diff",
										JSON.stringify({
											tool: fileExists ? "editedExistingFile" : "newFileCreated",
											path: getReadablePath(cwd, relPath),
											diff: userEdits,
										} satisfies ClineSayTool)
									)
									pushToolResult(
										`The user made the following updates to your content:\n\n${userEdits}\n\n` +
											`The updated content, which includes both your original modifications and the user's edits, has been successfully saved to ${relPath.toPosix()}. Here is the full, updated content of the file:\n\n` +
											`<final_file_content path="${relPath.toPosix()}">\n${finalContent}\n</final_file_content>\n\n` +
											`Please note:\n` +
											`1. You do not need to re-write the file with these changes, as they have already been applied.\n` +
											`2. Proceed with the task using this updated file content as the new baseline.\n` +
											`3. If the user's edits have addressed part of the task or changed the requirements, adjust your approach accordingly.` +
											`${newProblemsMessage}`
									)
								} else {
									pushToolResult(
										`The content was successfully saved to ${relPath.toPosix()}.${newProblemsMessage}`
									)
								}
								await this.diffViewProvider.reset()
								break
							}
						} catch (error) {
							await handleError("writing file", error)
							await this.diffViewProvider.reset()
							break
						}
					}
					case "read_file": {
						const relPath: string | undefined = block.params.path
						const sharedMessageProps: ClineSayTool = {
							tool: "readFile",
							path: getReadablePath(cwd, removeClosingTag("path", relPath)),
						}
						try {
							if (block.partial) {
								const partialMessage = JSON.stringify({
									...sharedMessageProps,
									content: undefined,
								} satisfies ClineSayTool)
								if (this.alwaysAllowReadOnly) {
									await this.say("tool", partialMessage, undefined, block.partial)
								} else {
									await this.ask("tool", partialMessage, block.partial).catch(() => {})
								}
								break
							} else {
								if (!relPath) {
									this.consecutiveMistakeCount++
									pushToolResult(await this.sayAndCreateMissingParamError("read_file", "path"))
									break
								}
								this.consecutiveMistakeCount = 0
								const absolutePath = path.resolve(cwd, relPath)
								const completeMessage = JSON.stringify({
									...sharedMessageProps,
									content: absolutePath,
								} satisfies ClineSayTool)
								if (this.alwaysAllowReadOnly) {
									await this.say("tool", completeMessage, undefined, false) // need to be sending partialValue bool, since undefined has its own purpose in that the message is treated neither as a partial or completion of a partial, but as a single complete message
								} else {
									const didApprove = await askApproval("tool", completeMessage)
									if (!didApprove) {
										break
									}
								}
								// now execute the tool like normal
								const content = await extractTextFromFile(absolutePath)
								pushToolResult(content)
								break
							}
						} catch (error) {
							await handleError("reading file", error)
							break
						}
					}
					case "list_files": {
						const relDirPath: string | undefined = block.params.path
						const recursiveRaw: string | undefined = block.params.recursive
						const recursive = recursiveRaw?.toLowerCase() === "true"
						const sharedMessageProps: ClineSayTool = {
							tool: !recursive ? "listFilesTopLevel" : "listFilesRecursive",
							path: getReadablePath(cwd, removeClosingTag("path", relDirPath)),
						}
						try {
							if (block.partial) {
								const partialMessage = JSON.stringify({
									...sharedMessageProps,
									content: "",
								} satisfies ClineSayTool)
								if (this.alwaysAllowReadOnly) {
									await this.say("tool", partialMessage, undefined, block.partial)
								} else {
									await this.ask("tool", partialMessage, block.partial).catch(() => {})
								}
								break
							} else {
								if (!relDirPath) {
									this.consecutiveMistakeCount++
									pushToolResult(await this.sayAndCreateMissingParamError("list_files", "path"))
									break
								}
								this.consecutiveMistakeCount = 0
								const absolutePath = path.resolve(cwd, relDirPath)
								const [files, didHitLimit] = await listFiles(absolutePath, recursive, 200)
								const result = formatResponse.formatFilesList(absolutePath, files, didHitLimit)
								const completeMessage = JSON.stringify({
									...sharedMessageProps,
									content: result,
								} satisfies ClineSayTool)
								if (this.alwaysAllowReadOnly) {
									await this.say("tool", completeMessage, undefined, false)
								} else {
									const didApprove = await askApproval("tool", completeMessage)
									if (!didApprove) {
										break
									}
								}
								pushToolResult(result)
								break
							}
						} catch (error) {
							await handleError("listing files", error)
							break
						}
					}
					case "list_code_definition_names": {
						const relDirPath: string | undefined = block.params.path
						const sharedMessageProps: ClineSayTool = {
							tool: "listCodeDefinitionNames",
							path: getReadablePath(cwd, removeClosingTag("path", relDirPath)),
						}
						try {
							if (block.partial) {
								const partialMessage = JSON.stringify({
									...sharedMessageProps,
									content: "",
								} satisfies ClineSayTool)
								if (this.alwaysAllowReadOnly) {
									await this.say("tool", partialMessage, undefined, block.partial)
								} else {
									await this.ask("tool", partialMessage, block.partial).catch(() => {})
								}
								break
							} else {
								if (!relDirPath) {
									this.consecutiveMistakeCount++
									pushToolResult(
										await this.sayAndCreateMissingParamError("list_code_definition_names", "path")
									)
									break
								}
								this.consecutiveMistakeCount = 0
								const absolutePath = path.resolve(cwd, relDirPath)
								const result = await parseSourceCodeForDefinitionsTopLevel(absolutePath)
								const completeMessage = JSON.stringify({
									...sharedMessageProps,
									content: result,
								} satisfies ClineSayTool)
								if (this.alwaysAllowReadOnly) {
									await this.say("tool", completeMessage, undefined, false)
								} else {
									const didApprove = await askApproval("tool", completeMessage)
									if (!didApprove) {
										break
									}
								}
								pushToolResult(result)
								break
							}
						} catch (error) {
							await handleError("parsing source code definitions", error)
							break
						}
					}
					case "search_files": {
						const relDirPath: string | undefined = block.params.path
						const regex: string | undefined = block.params.regex
						const filePattern: string | undefined = block.params.file_pattern
						const sharedMessageProps: ClineSayTool = {
							tool: "searchFiles",
							path: getReadablePath(cwd, removeClosingTag("path", relDirPath)),
							regex: removeClosingTag("regex", regex),
							filePattern: removeClosingTag("file_pattern", filePattern),
						}
						try {
							if (block.partial) {
								const partialMessage = JSON.stringify({
									...sharedMessageProps,
									content: "",
								} satisfies ClineSayTool)
								if (this.alwaysAllowReadOnly) {
									await this.say("tool", partialMessage, undefined, block.partial)
								} else {
									await this.ask("tool", partialMessage, block.partial).catch(() => {})
								}
								break
							} else {
								if (!relDirPath) {
									this.consecutiveMistakeCount++
									pushToolResult(await this.sayAndCreateMissingParamError("search_files", "path"))
									break
								}
								if (!regex) {
									this.consecutiveMistakeCount++
									pushToolResult(await this.sayAndCreateMissingParamError("search_files", "regex"))
									break
								}
								this.consecutiveMistakeCount = 0
								const absolutePath = path.resolve(cwd, relDirPath)
								const results = await regexSearchFiles(cwd, absolutePath, regex, filePattern)
								const completeMessage = JSON.stringify({
									...sharedMessageProps,
									content: results,
								} satisfies ClineSayTool)
								if (this.alwaysAllowReadOnly) {
									await this.say("tool", completeMessage, undefined, false)
								} else {
									const didApprove = await askApproval("tool", completeMessage)
									if (!didApprove) {
										break
									}
								}
								pushToolResult(results)
								break
							}
						} catch (error) {
							await handleError("searching files", error)
							break
						}
					}
					case "browser_action": {
						const action: BrowserAction | undefined = block.params.action as BrowserAction
						const url: string | undefined = block.params.url
						const coordinate: string | undefined = block.params.coordinate
						const text: string | undefined = block.params.text
						if (!action || !browserActions.includes(action)) {
							// checking for action to ensure it is complete and valid
							if (!block.partial) {
								// if the block is complete and we don't have a valid action this is a mistake
								this.consecutiveMistakeCount++
								pushToolResult(await this.sayAndCreateMissingParamError("browser_action", "action"))
								await this.browserSession.closeBrowser()
							}
							break
						}

						try {
							if (block.partial) {
								if (action === "launch") {
									await this.ask(
										"browser_action_launch",
										removeClosingTag("url", url),
										block.partial
									).catch(() => {})
								} else {
									await this.say(
										"browser_action",
										JSON.stringify({
											action: action as BrowserAction,
											coordinate: removeClosingTag("coordinate", coordinate),
											text: removeClosingTag("text", text),
										} satisfies ClineSayBrowserAction),
										undefined,
										block.partial
									)
								}
								break
							} else {
								let browserActionResult: BrowserActionResult
								if (action === "launch") {
									if (!url) {
										this.consecutiveMistakeCount++
										pushToolResult(
											await this.sayAndCreateMissingParamError("browser_action", "url")
										)
										await this.browserSession.closeBrowser()
										break
									}
									this.consecutiveMistakeCount = 0
									const didApprove = await askApproval("browser_action_launch", url)
									if (!didApprove) {
										break
									}

									// NOTE: it's okay that we call this message since the partial inspect_site is finished streaming. The only scenario we have to avoid is sending messages WHILE a partial message exists at the end of the messages array. For example the api_req_finished message would interfere with the partial message, so we needed to remove that.
									// await this.say("inspect_site_result", "") // no result, starts the loading spinner waiting for result
									await this.say("browser_action_result", "") // starts loading spinner

									await this.browserSession.launchBrowser()
									browserActionResult = await this.browserSession.navigateToUrl(url)
								} else {
									if (action === "click") {
										if (!coordinate) {
											this.consecutiveMistakeCount++
											pushToolResult(
												await this.sayAndCreateMissingParamError("browser_action", "coordinate")
											)
											await this.browserSession.closeBrowser()
											break // can't be within an inner switch
										}
									}
									if (action === "type") {
										if (!text) {
											this.consecutiveMistakeCount++
											pushToolResult(
												await this.sayAndCreateMissingParamError("browser_action", "text")
											)
											await this.browserSession.closeBrowser()
											break
										}
									}
									this.consecutiveMistakeCount = 0
									await this.say(
										"browser_action",
										JSON.stringify({
											action: action as BrowserAction,
											coordinate,
											text,
										} satisfies ClineSayBrowserAction),
										undefined,
										false
									)
									switch (action) {
										case "click":
											browserActionResult = await this.browserSession.click(coordinate!)
											break
										case "type":
											browserActionResult = await this.browserSession.type(text!)
											break
										case "scroll_down":
											browserActionResult = await this.browserSession.scrollDown()
											break
										case "scroll_up":
											browserActionResult = await this.browserSession.scrollUp()
											break
										case "close":
											browserActionResult = await this.browserSession.closeBrowser()
											break
									}
								}

								switch (action) {
									case "launch":
									case "click":
									case "type":
									case "scroll_down":
									case "scroll_up":
										await this.say("browser_action_result", JSON.stringify(browserActionResult))
										pushToolResult(
											formatResponse.toolResult(
												`The browser action has been executed. The console logs and screenshot have been captured for your analysis.\n\nConsole logs:\n${
													browserActionResult.logs || "(No new logs)"
												}\n\n(REMEMBER: if you need to proceed to using non-\`browser_action\` tools or launch a new browser, you MUST first close this browser. For example, if after analyzing the logs and screenshot you need to edit a file, you must first close the browser before you can use the write_to_file tool.)`,
												browserActionResult.screenshot ? [browserActionResult.screenshot] : []
											)
										)
										break
									case "close":
										pushToolResult(
											formatResponse.toolResult(
												`The browser has been closed. You may now proceed to using other tools.`
											)
										)
										break
								}
								break
							}
						} catch (error) {
							await this.browserSession.closeBrowser() // if any error occurs, the browser session is terminated
							await handleError("executing browser action", error)
							break
						}
					}
					case "execute_command": {
						const command: string | undefined = block.params.command
						try {
							if (block.partial) {
								await this.ask("command", removeClosingTag("command", command), block.partial).catch(
									() => {}
								)
								break
							} else {
								if (!command) {
									this.consecutiveMistakeCount++
									pushToolResult(
										await this.sayAndCreateMissingParamError("execute_command", "command")
									)
									break
								}
								this.consecutiveMistakeCount = 0
								const didApprove = await askApproval("command", command)
								if (!didApprove) {
									break
								}
								const [userRejected, result] = await this.executeCommandTool(command)
								if (userRejected) {
									this.didRejectTool = true
								}
								pushToolResult(result)
								break
							}
						} catch (error) {
							await handleError("executing command", error)
							break
						}
					}

					case "ask_followup_question": {
						const question: string | undefined = block.params.question
						try {
							if (block.partial) {
								await this.ask("followup", removeClosingTag("question", question), block.partial).catch(
									() => {}
								)
								break
							} else {
								if (!question) {
									this.consecutiveMistakeCount++
									pushToolResult(
										await this.sayAndCreateMissingParamError("ask_followup_question", "question")
									)
									break
								}
								this.consecutiveMistakeCount = 0
								const { text, images } = await this.ask("followup", question, false)
								await this.say("user_feedback", text ?? "", images)
								pushToolResult(formatResponse.toolResult(`<answer>\n${text}\n</answer>`, images))
								break
							}
						} catch (error) {
							await handleError("asking question", error)
							break
						}
					}
					case "attempt_completion": {
						/*
						this.consecutiveMistakeCount = 0
						let resultToSend = result
						if (command) {
							await this.say("completion_result", resultToSend)
							// TODO: currently we don't handle if this command fails, it could be useful to let cline know and retry
							const [didUserReject, commandResult] = await this.executeCommand(command, true)
							// if we received non-empty string, the command was rejected or failed
							if (commandResult) {
								return [didUserReject, commandResult]
							}
							resultToSend = ""
						}
						const { response, text, images } = await this.ask("completion_result", resultToSend) // this prompts webview to show 'new task' button, and enable text input (which would be the 'text' here)
						if (response === "yesButtonClicked") {
							return [false, ""] // signals to recursive loop to stop (for now this never happens since yesButtonClicked will trigger a new task)
						}
						await this.say("user_feedback", text ?? "", images)
						return [
						*/
						const result: string | undefined = block.params.result
						const command: string | undefined = block.params.command
						try {
							const lastMessage = this.clineMessages.at(-1)
							if (block.partial) {
								if (command) {
									// the attempt_completion text is done, now we're getting command
									// remove the previous partial attempt_completion ask, replace with say, post state to webview, then stream command

									// const secondLastMessage = this.clineMessages.at(-2)
									if (lastMessage && lastMessage.ask === "command") {
										// update command
										await this.ask(
											"command",
											removeClosingTag("command", command),
											block.partial
										).catch(() => {})
									} else {
										// last message is completion_result
										// we have command string, which means we have the result as well, so finish it (doesnt have to exist yet)
										await this.say(
											"completion_result",
											removeClosingTag("result", result),
											undefined,
											false
										)
										await this.ask(
											"command",
											removeClosingTag("command", command),
											block.partial
										).catch(() => {})
									}
								} else {
									// no command, still outputting partial result
									await this.say(
										"completion_result",
										removeClosingTag("result", result),
										undefined,
										block.partial
									)
								}
								break
							} else {
								if (!result) {
									this.consecutiveMistakeCount++
									pushToolResult(
										await this.sayAndCreateMissingParamError("attempt_completion", "result")
									)
									break
								}
								this.consecutiveMistakeCount = 0

								let commandResult: ToolResponse | undefined
								if (command) {
									if (lastMessage && lastMessage.ask !== "command") {
										// havent sent a command message yet so first send completion_result then command
										await this.say("completion_result", result, undefined, false)
									}

									// complete command message
									const didApprove = await askApproval("command", command)
									if (!didApprove) {
										break
									}
									const [userRejected, execCommandResult] = await this.executeCommandTool(command!)
									if (userRejected) {
										this.didRejectTool = true
										pushToolResult(execCommandResult)
										break
									}
									// user didn't reject, but the command may have output
									commandResult = execCommandResult
								} else {
									await this.say("completion_result", result, undefined, false)
								}

								// we already sent completion_result says, an empty string asks relinquishes control over button and field
								const { response, text, images } = await this.ask("completion_result", "", false)
								if (response === "yesButtonClicked") {
									pushToolResult("") // signals to recursive loop to stop (for now this never happens since yesButtonClicked will trigger a new task)
									break
								}
								await this.say("user_feedback", text ?? "", images)

								const toolResults: (Anthropic.TextBlockParam | Anthropic.ImageBlockParam)[] = []
								if (commandResult) {
									if (typeof commandResult === "string") {
										toolResults.push({ type: "text", text: commandResult })
									} else if (Array.isArray(commandResult)) {
										toolResults.push(...commandResult)
									}
								}
								toolResults.push({
									type: "text",
									text: `The user has provided feedback on the results. Consider their input to continue the task, and then attempt completion again.\n<feedback>\n${text}\n</feedback>`,
								})
								toolResults.push(...formatResponse.imageBlocks(images))
								this.userMessageContent.push({
									type: "text",
									text: `${toolDescription()} Result:`,
								})
								this.userMessageContent.push(...toolResults)

								break
							}
						} catch (error) {
							await handleError("inspecting site", error)
							break
						}
					}
				}
				break
		}

		/*
		Seeing out of bounds is fine, it means that the next too call is being built up and ready to add to assistantMessageContent to present. 
		When you see the UI inactive during this, it means that a tool is breaking without presenting any UI. For example the write_to_file tool was breaking when relpath was undefined, and for invalid relpath it never presented UI.
		*/
		this.presentAssistantMessageLocked = false // this needs to be placed here, if not then calling this.presentAssistantMessage below would fail (sometimes) since it's locked
		// NOTE: when tool is rejected, iterator stream is interrupted and it waits for userMessageContentReady to be true. Future calls to present will skip execution since didRejectTool and iterate until contentIndex is set to message length and it sets userMessageContentReady to true itself (instead of preemptively doing it in iterator)
		if (!block.partial || this.didRejectTool || this.didAlreadyUseTool) {
			// block is finished streaming and executing
			if (this.currentStreamingContentIndex === this.assistantMessageContent.length - 1) {
				// its okay that we increment if !didCompleteReadingStream, it'll just return bc out of bounds and as streaming continues it will call presentAssitantMessage if a new block is ready. if streaming is finished then we set userMessageContentReady to true when out of bounds. This gracefully allows the stream to continue on and all potential content blocks be presented.
				// last block is complete and it is finished executing
				this.userMessageContentReady = true // will allow pwaitfor to continue
			}

			// call next block if it exists (if not then read stream will call it when its ready)
			this.currentStreamingContentIndex++ // need to increment regardless, so when read stream calls this function again it will be streaming the next block

			if (this.currentStreamingContentIndex < this.assistantMessageContent.length) {
				// there are already more content blocks to stream, so we'll call this function ourselves
				// await this.presentAssistantContent()

				this.presentAssistantMessage()
				return
			}
		}
		// block is partial, but the read stream may have finished
		if (this.presentAssistantMessageHasPendingUpdates) {
			this.presentAssistantMessage()
		}
	}

    private async loadContext(userContent: UserContent, includeFileDetails: boolean): Promise<[UserContent, string]> {
        // Implementation details for loading context
        // This will be implemented in a separate update
        return [userContent, ""]
    }

    private async addToApiConversationHistory(message: Anthropic.MessageParam): Promise<void> {
        this.apiConversationHistory.push(message)
        // Implementation details for saving history
        // This will be implemented in a separate update
    }

    private async overwriteApiConversationHistory(newHistory: Anthropic.MessageParam[]): Promise<void> {
        this.apiConversationHistory = newHistory
        // Implementation details for saving history
        // This will be implemented in a separate update
    }

    abortTask(): void {
        this.abort = true
        this.terminalManager.disposeAll()
        this.browserService.closeBrowser()
    }
}
