Task Manager
============
The task manager is the AI agent responsible for managing the state of the task and deploying tasks to sub models.

This is Microsoft's approach to task management:
  Task Orchestration Process
  Orchestrator
      Task Ledger
          Create or update ledger:
              Given or verified facts
              Facts to look up
              Facts to derive (computation or logic)
              Educated guesses
              Task plan

      Progress Ledger
          Update progress ledger:
              Is the task complete?
              Identify unproductive loops.
              Determine if progress is being made.
              Identify the next agent.
              Provide the next agents's instruction.

  Decision Points

      Task Complete?
          If Yes: Report the final answer or educated guess as Task Complete!
          If No: Check if progress is being made.

      Progress Being Made?
          If Yes: Continue updating the Progress Ledger.
          If No: Check the stall count.

      Stall Count > 2?
          If Yes: Return to the Task Ledger for revision.
          If No: Continue updating the Progress Ledger.

  Agents

      Coder: Write code and reason to solve tasks.
      ComputerTerminal: Execute code written by the Coder agent.
      WebSurfer: Browse the internet (navigate pages, fill forms, etc.).
      FileSurfer: Navigate files (e.g., PDFs, PowerPoint presentations, WAV files, etc.).

  This flowchart emphasizes a systematic approach to task completion, with loops for revision and validation to ensure progress.

  Links
  https://www.microsoft.com/en-us/research/articles/magentic-one-a-generalist-multi-agent-system-for-solving-complex-tasks/
  https://www.microsoft.com/en-us/research/uploads/prod/2024/11/magentic_orchestrator.png

Takeaways from Microsoft's Approach:
Stalling/loops/hanging, Progress, and Completion are key decision points.

How should coding be done.

Approach 1: Feed the file to the AI model, and have it make updates, as there are errors, just feed the new errors to the AI and ask for correction, rinse and repeat until it's functioning. Maybe force line numbers to be included when updating code.


========================

Prompt for helping me come up with agents and their system prompts

I am trying to build an agentic AI system that utilizes several different kinds of agents to all perform work, and report back to an "orchestrator". The orchestrator will then decide what to do next based on the reports from the agents. It needs to maintain a state of the task, both the progress that has been made, the current progress on the overall plan, and a plan.

It needs to able to handle a variety of tasks, and be able to handle tasks that require multiple agents to work together. I am looking for help coming up with the different kinds of agents that I will need, and the system prompts that I will need to use to communicate with them. I am also looking for help coming up with the system prompts that the orchestrator will use to communicate with the agents. I am looking for a system that is flexible and can handle a wide variety of tasks, and that can be easily extended to handle new tasks as they come up.

I need help also determining a "framework" of sorts to capture context, requirements, completion etc. These frameworks can differ agent to agent, or be a "generic" framework they all use, but the purpose of it is to help the agent maintain context, be efficient, and be able to communicate effict.

The key things to create an orchestration of agentic AI

- Frameworks for agents to capture context, requirements, completion etc.
  - These frameworks could differ agent to agent and actually should be different.
  - Workers need to generate status reports
- Which agents are needed
  - Orchestrator
    - they manage the task, progress, and completion
  - Architect
    - they manage the system design, understanding it's existing structure, and coming up with the implementation
  - Coder
    - they manage the implementation of code and the testing of that code.
  - Code Summarizer
    - Reviewing the 4o and 4-mini summaries demonstrate that, 4o is significantly better at breaking down and understanding code. Instead 4-mini should specifically be required to review for references or usages of things. Not meta-analysis of anykind.
- Contextual system that captures different degrees of context according to the model.
