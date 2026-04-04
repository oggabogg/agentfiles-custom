import { readdirSync, readFileSync, existsSync } from "fs";
import { join } from "path";
import { homedir, userInfo } from "os";
import { createHash } from "crypto";
import type { ConversationItem, ConversationMessage } from "../types";

const home = homedir();
const username = userInfo().username;
// Gemini CLI has stored chats in two locations across versions — scan both
const GEMINI_CHATS_DIRS = [
	join(home, ".gemini-app", "tmp", username, "chats"),
	join(home, ".gemini-app", ".gemini", "tmp", username, "chats"),
];
const GEMINI_PROJECTS_FILE = join(home, ".gemini-app", ".gemini", "projects.json");

/** sha256(path) — matches what Gemini CLI uses for projectHash */
function hashPath(p: string): string {
	return createHash("sha256").update(p).digest("hex");
}

/** Build a hash → readable name map from ~/.gemini-app/.gemini/projects.json */
function buildProjectMap(): Map<string, string> {
	const map = new Map<string, string>();
	try {
		if (!existsSync(GEMINI_PROJECTS_FILE)) return map;
		const data = JSON.parse(readFileSync(GEMINI_PROJECTS_FILE, "utf-8"));
		const projects = data?.projects as Record<string, string> | undefined;
		if (projects) {
			for (const [path, name] of Object.entries(projects)) {
				map.set(hashPath(path), typeof name === "string" ? name : path.split("/").pop() || "project");
			}
		}
	} catch { /* ignore */ }
	return map;
}

function extractGeminiMessages(rawMessages: unknown[]): {
	messages: ConversationMessage[];
	firstTimestamp: string;
	lastTimestamp: string;
} {
	const messages: ConversationMessage[] = [];
	let firstTimestamp = "";
	let lastTimestamp = "";

	for (const raw of rawMessages) {
		if (typeof raw !== "object" || raw === null) continue;
		const msg = raw as Record<string, unknown>;
		const ts = typeof msg.timestamp === "string" ? msg.timestamp : "";
		const type = msg.type as string | undefined;

		if (ts) {
			if (!firstTimestamp) firstTimestamp = ts;
			lastTimestamp = ts;
		}

		if (type === "user") {
			const content = msg.content;
			let text = "";
			if (Array.isArray(content)) {
				text = content
					.map((c: unknown) => (typeof c === "object" && c !== null ? (c as Record<string, unknown>).text : ""))
					.filter(Boolean)
					.join("\n");
			} else if (typeof content === "string") {
				text = content;
			}
			if (text.trim()) {
				messages.push({ role: "human", text: text.trim(), timestamp: ts });
			}
		}

		if (type === "gemini") {
			const text = typeof msg.content === "string" ? msg.content.trim() : "";
			if (text) {
				messages.push({ role: "assistant", text, timestamp: ts });
			}
		}
		// "info" messages are skipped
	}

	return { messages, firstTimestamp, lastTimestamp };
}

export function parseAllGeminiConversations(): ConversationItem[] {
	const projectMap = buildProjectMap();
	const conversations: ConversationItem[] = [];
	const seen = new Set<string>();

	for (const chatsDir of GEMINI_CHATS_DIRS) {
		if (!existsSync(chatsDir)) continue;
		let files: string[];
		try {
			files = readdirSync(chatsDir).filter((f) => f.endsWith(".json"));
		} catch { continue; }

		for (const file of files) {
			const filePath = join(chatsDir, file);
		try {
				const raw = JSON.parse(readFileSync(filePath, "utf-8"));
				const sessionId: string = raw.sessionId || file.replace(".json", "");
				if (seen.has(sessionId)) continue;
				seen.add(sessionId);

				const projectHash: string = raw.projectHash || "";
				const projectName = projectMap.get(projectHash) || "Gemini CLI";

				const rawMessages: unknown[] = Array.isArray(raw.messages) ? raw.messages : [];
				const { messages, firstTimestamp, lastTimestamp } = extractGeminiMessages(rawMessages);
				if (messages.length === 0) continue;

				const firstHuman = messages.find((m) => m.role === "human");
				const title = firstHuman
					? firstHuman.text.slice(0, 120).replace(/\n/g, " ")
					: "(empty conversation)";

				conversations.push({
					id: `gemini-${sessionId}`,
					uuid: `gemini-${sessionId}`,
					project: projectName,
					projectPath: chatsDir,
					title,
					messages,
					messageCount: messages.length,
					firstTimestamp: firstTimestamp || raw.startTime || "",
					lastTimestamp: lastTimestamp || raw.lastUpdated || "",
					tags: [],
					customTags: [],
					isFavorite: false,
					filePath,
					source: "gemini",
				});
			} catch { continue; }
		}
	}

	conversations.sort((a, b) => (b.lastTimestamp || "").localeCompare(a.lastTimestamp || ""));
	return conversations;
}
