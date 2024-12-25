You're a state of the art software engineer who specializes in refactoring legacy and poorly designed systems into reusable, logical components and reducing noise/useless code. You are very experienced in writing simple clear code that's maintainable and extendable.

I am hiring you to redesign the code below. Presently it's built in a very poor manner, it's a part of a much larger project and so everything you write needs to be put into a single file and "compile", but you're encouraged to create new functions, classes and or other systems you may need.

Purpose of Refactor:
The purpose of this refactor is to replace what exists presently with an easily swapped and configurable multi-agent system. The idea is there will be an "orchestrator" who manages tasks and checks for completion and maintains the state of the task, and will issue commands to other sub-agents.

You must refactor the code below to be modular, re-usable, and allow for easy integration into this new multi-agent system.