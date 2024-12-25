import { BrowserSession } from "../../services/browser/BrowserSession"
import { BrowserAction, BrowserActionResult } from "../../shared/ExtensionMessage"
import * as vscode from "vscode"

export class BrowserService {
    private browserSession: BrowserSession
    private isActive: boolean = false

    constructor(context: vscode.ExtensionContext) {
        this.browserSession = new BrowserSession(context)
    }

    async launchBrowser(url: string): Promise<BrowserActionResult> {
        await this.browserSession.launchBrowser()
        this.isActive = true
        return await this.browserSession.navigateToUrl(url)
    }

    async click(coordinate: string): Promise<BrowserActionResult> {
        return await this.browserSession.click(coordinate)
    }

    async type(text: string): Promise<BrowserActionResult> {
        return await this.browserSession.type(text)
    }

    async scrollDown(): Promise<BrowserActionResult> {
        return await this.browserSession.scrollDown()
    }

    async scrollUp(): Promise<BrowserActionResult> {
        return await this.browserSession.scrollUp()
    }

    async closeBrowser(): Promise<BrowserActionResult> {
        this.isActive = false
        return await this.browserSession.closeBrowser()
    }

    isBrowserActive(): boolean {
        return this.isActive
    }

    formatBrowserActionResult(result: BrowserActionResult, action: BrowserAction): string {
        switch (action) {
            case "launch":
            case "click":
            case "type":
            case "scroll_down":
            case "scroll_up":
                return `The browser action has been executed. The console logs and screenshot have been captured for your analysis.\n\n` +
                    `Console logs:\n${result.logs || "(No new logs)"}\n\n` +
                    `(REMEMBER: if you need to proceed to using non-\`browser_action\` tools or launch a new browser, ` +
                    `you MUST first close this browser. For example, if after analyzing the logs and screenshot you need ` +
                    `to edit a file, you must first close the browser before you can use the write_to_file tool.)`
            case "close":
                return `The browser has been closed. You may now proceed to using other tools.`
            default:
                return `Browser action completed.`
        }
    }
}
