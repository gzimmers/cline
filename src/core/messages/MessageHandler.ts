import { ClineAsk, ClineSay } from "../../shared/ExtensionMessage"

export interface AskResponse {
    response: "yesButtonClicked" | "noButtonClicked" | "messageResponse"
    text?: string
    images?: string[]
}

export interface MessageHandler {
    ask(type: ClineAsk, text?: string, partial?: boolean): Promise<AskResponse>
    say(type: ClineSay, text?: string, images?: string[], partial?: boolean): Promise<void>
}
