You're a state of the art software engineer who specializes in refactoring legacy and poorly designed systems into reusable, logical components and reducing noise/useless code. You are very experienced in writing simple clear code that's maintainable and extendable.

I am hiring you to redesign the code below. Presently it's built in a very poor manner, it's a part of a much larger project and so everything you write needs to be put into a single file and "compile", but you're encouraged to create new functions, classes and or other systems you may need.

Purpose of Refactor:
The purpose of this refactor is to replace what exists presently with an easily swapped and configurable multi-agent system. The idea is there will be an "orchestrator" who manages tasks and checks for completion and maintains the state of the task, and will issue commands to other sub-agents.

You must refactor the code below to be modular, re-usable, and allow for easy integration into this new multi-agent system.

===================================

--
I want you to help me refine the below prompt. My overall goal, summarized, is I want to maximize reuse of the eixsting code while deleting the existing "agent" workflow, where I can instead replace it with an external multi-agent workflow.
--

I'm in the process of rebuilding a vscode extension, I want to fundamentally change how the overall application works, but I want to maximize reuse. I am going to give you a large code file with a lot of code, and it does a lot of different things, but I need you to refactor it, and truncate a lot of the functionality, while also creating a framework for me to reuse what's there but also enable my new architecture.

In a rough summary I will explain what the code's overall purpose is. It manages the interaction with an AI model, history, and execution of tools among other things. Presently it's built entirely around a single "agent" where as you engage with it, it recursively calls itself to achieve a task. It will retrieve context, accrue it, and then prompt itself along with occassional user input and perform actions.

What I am looking for is to have a framework in place to leverage a multi-agent system instead of this very one-dimensional agent system "cline". Instead of having one agent, with an ever growing context, recursively calling itself and integrating with vscode, I want to have a multi-agent system.

Here's your task: You must refactor this code, you must refactor it in a way that it provides a framework for engaging with the UI and the user, but instead of using the existing AIs "workflow" where it calls itself and builds context etc, that will be managed in another multi-agent system. I need the refactored code to extract all the re-usable code, and get rid of any junk that won't be useful in this new system. The newly refactored code should also allow for easy integration and connection of these different components, maximizing modularity, reuse, and readability.

--

Project Overview:

I am rebuilding a Visual Studio Code extension that currently relies on a single-agent system named "cline." This extension manages interactions with an AI model, maintains history, executes tools, and performs other functions. The current agent recursively calls itself to achieve tasks, retrieves and accrues context, and interacts with the user within VSCode.

Objective:

I aim to replace the existing single-agent workflow with an external multi-agent system. My goal is to maximize the reuse of the existing code while removing the parts specific to the current agent's recursive workflow. The refactored code should serve as a modular framework that facilitates interaction between the UI, the user, and the new multi-agent system.

Your Task:

    Refactor the Existing Code:
        Extract Reusable Components: Identify and isolate code segments that are not tightly coupled with the single-agent workflow.
        Remove Obsolete Code: Eliminate any code that is specific to the current agent's recursive context-building and self-calling mechanisms.
        Enhance Modularity: Reorganize the codebase to promote modularity, making it easier to maintain and extend.

    Create a New Framework:
        Design for Integration: Structure the refactored code to allow seamless integration with an external multi-agent system.
        Maintain UI Interaction: Ensure that the code responsible for UI and user interactions within VSCode remains functional and is properly decoupled from the agent logic.
        Improve Readability: Clean up the code to enhance readability, adding comments and documentation where necessary.

    Ensure Future Reusability:
        Facilitate Component Connection: Design the framework so that different components can be easily connected or replaced.
        Support Extensibility: Make it straightforward to add new features or agents without significant rewrites.

Deliverables:

    A refactored codebase with unnecessary components removed.
    A modular framework that interfaces with the UI and is ready to integrate with the external multi-agent system.
    Documentation outlining the new architecture and explaining how to connect and extend components.

Key Considerations:

    Maximize Code Reuse: Retain as much of the existing, useful code as possible to save development time and resources.
    Promote Modularity and Readability: Write clean, well-organized code that is easy for others to understand and work with.
    Enable Easy Integration: The new framework should be designed with integration in mind, using clear interfaces and abstraction layers where appropriate.

THE DELIVERABLES ARE ESSENTIAL AND YOU MUST SATISFY THEM. YOU MUST COMPLETE IT IN IT'S ENTIRIETY. ANYTIME YOU WRITE CODE, DO NOT TRUNCATE THE CODE.

It's your job to refactor the code and provide implementations for the new system.

===================================

I am trying my best to understand the overarching lifecycle of this massive code file. It captures a significant amount of functionality, but what I'm trying to wrap my head around is the overarching lifecycle of the "cline" flow. How the user initiates input, where that goes, how it gets processed, and how it then comes back to the user and so on.

Perform an analysis on the code and explain to me it's overarching lifecycle and flow, referencing code etc. The things that I want you to keep in mind is the fact that I'm planning on replacing this cline with my own implementation, so it's important that I understand what's going on and can effectively replace it.