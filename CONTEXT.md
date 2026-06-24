# Vendor Agent Repo Learning

This context captures the language for studying the two vendored agent repositories in this workspace. It is a glossary for the learning track, not an implementation plan.

## Language

**Teaching Workspace**:
The root of this repository, where the mission, resources, lessons, references, notes, learning records, and context glossary live.
_Avoid_: teaching section, course folder

**Vendor Repo**:
A local checkout under `vendor/` used as source material for learning and comparison.
_Avoid_: vendor library, dependency

**OpenClaw**:
The vendored OpenClaw repository studied first in this learning track.
_Avoid_: claw repo, openclaw library

**Hermes Agent**:
The vendored Nous Research Hermes Agent repository studied after the OpenClaw orientation track.
_Avoid_: hermes library, hermes clone

**Gateway**:
OpenClaw's long-lived control plane for channels, sessions, tools, events, clients, and nodes.
_Avoid_: backend, server, daemon

**Channel**:
An OpenClaw messaging surface that carries inbound and outbound conversation traffic, such as Telegram, WhatsApp, Slack, Discord, or WebChat.
_Avoid_: integration, app, connector

**Node**:
An OpenClaw device or headless peer that connects to the Gateway with node identity and exposes declared device capabilities.
_Avoid_: client, worker, device

**Agent Runtime**:
OpenClaw's embedded execution surface for model discovery, tool wiring, prompt assembly, session management, and reply delivery.
_Avoid_: agent framework, bot engine

**Agent Workspace**:
The working directory OpenClaw gives the agent runtime for tools, context files, skills, and user-editable bootstrap material.
_Avoid_: project folder, cwd

**Session**:
An OpenClaw conversation context chosen from message origin, lifecycle rules, and isolation policy.
_Avoid_: thread, chat history

**Plugin**:
An OpenClaw capability package that owns provider, channel, tool, or feature behavior outside the core runtime boundary.
_Avoid_: extension, module

**Plugin SDK**:
The supported contract plugins use to cross into OpenClaw core without importing internal runtime files.
_Avoid_: internal API, helper barrel
