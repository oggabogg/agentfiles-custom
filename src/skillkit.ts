import { execSync } from "child_process";
import { existsSync, readdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";

const HOME = homedir();
const DB_PATH = join(HOME, ".skillkit", "analytics.db");

function buildPath(): string {
	const extra = [
		"/usr/local/bin",
		"/opt/homebrew/bin",
		join(HOME, ".local", "bin"),
		join(HOME, ".bun", "bin"),
	];
	const nvmDir = join(HOME, ".nvm", "versions", "node");
	try {
		for (const d of readdirSync(nvmDir)) {
			extra.push(join(nvmDir, d, "bin"));
		}
	} catch { /* empty */ }
	const miseDir = join(HOME, ".local", "share", "mise", "installs");
	for (const runtime of ["node", "bun"]) {
		try {
			for (const d of readdirSync(join(miseDir, runtime))) {
				extra.push(join(miseDir, runtime, d, "bin"));
			}
		} catch { /* empty */ }
	}
	return [...extra, process.env.PATH || ""].join(":");
}

function findSkillkitBin(): string | null {
	const searchPaths = [
		"/usr/local/bin/skillkit",
		"/opt/homebrew/bin/skillkit",
		join(HOME, ".local", "bin", "skillkit"),
		join(HOME, ".bun", "bin", "skillkit"),
		join(HOME, ".local", "share", "mise", "shims", "skillkit"),
	];
	for (const p of searchPaths) {
		if (existsSync(p)) return p;
	}
	const nvmDir = join(HOME, ".nvm", "versions", "node");
	try {
		for (const d of readdirSync(nvmDir)) {
			const p = join(nvmDir, d, "bin", "skillkit");
			if (existsSync(p)) return p;
		}
	} catch { /* empty */ }
	const miseDir = join(HOME, ".local", "share", "mise", "installs");
	for (const runtime of ["node", "bun"]) {
		try {
			for (const d of readdirSync(join(miseDir, runtime))) {
				const p = join(miseDir, runtime, d, "bin", "skillkit");
				if (existsSync(p)) return p;
			}
		} catch { /* empty */ }
	}
	return null;
}

let _bin: string | null | undefined;
function getSkillkitBin(): string | null {
	if (_bin === undefined) _bin = findSkillkitBin();
	return _bin;
}

export interface SkillkitStats {
	uses: number;
	lastUsed: string | null;
	daysSinceUsed: number | null;
	isStale: boolean;
	isHeavy: boolean;
}

export function isSkillkitAvailable(): boolean {
	return getSkillkitBin() !== null || existsSync(DB_PATH);
}

export function runSkillkitJson(cmd: string): Record<string, unknown> | unknown[] | null {
	const bin = getSkillkitBin();
	if (!bin) return null;
	try {
		const out = execSync(`${bin} ${cmd} --json`, {
			encoding: "utf-8",
			timeout: 15000,
			env: { ...process.env, NO_COLOR: "1", PATH: buildPath() },
			stdio: ["pipe", "pipe", "pipe"],
		}).trim();
		const jsonStart = out.indexOf("{");
		const jsonStartArr = out.indexOf("[");
		const start = jsonStart === -1 ? jsonStartArr : jsonStartArr === -1 ? jsonStart : Math.min(jsonStart, jsonStartArr);
		if (start === -1) return null;
		return JSON.parse(out.slice(start));
	} catch { /* empty */ return null; }
}

export function getSkillkitStats(): Map<string, SkillkitStats> {
	const stats = new Map<string, SkillkitStats>();
	if (!isSkillkitAvailable()) return stats;

	const data = runSkillkitJson("stats") as {
		top_skills: { name: string; total: number; daily: { date: string; count: number }[] }[];
	} | null;

	if (!data?.top_skills) return stats;

	const now = Date.now();
	for (const skill of data.top_skills) {
		const lastDay = skill.daily.length > 0
			? skill.daily[skill.daily.length - 1]?.date
			: null;
		let daysSinceUsed: number | null = null;

		if (lastDay) {
			daysSinceUsed = Math.floor((now - new Date(lastDay).getTime()) / (1000 * 60 * 60 * 24));
		}

		stats.set(skill.name, {
			uses: skill.total,
			lastUsed: lastDay || null,
			daysSinceUsed,
			isStale: daysSinceUsed !== null && daysSinceUsed > 30,
			isHeavy: false,
		});
	}

	return stats;
}

export interface SkillkitStatsWithDaily extends SkillkitStats {
	daily: { date: string; count: number }[];
}

export function getSkillkitStatsWithDaily(): Map<string, SkillkitStatsWithDaily> {
	const stats = new Map<string, SkillkitStatsWithDaily>();
	if (!isSkillkitAvailable()) return stats;

	const data = runSkillkitJson("stats") as {
		top_skills: { name: string; total: number; daily: { date: string; count: number }[] }[];
	} | null;

	if (!data?.top_skills) return stats;

	const now = Date.now();
	for (const skill of data.top_skills) {
		const lastDay = skill.daily.length > 0
			? skill.daily[skill.daily.length - 1]?.date
			: null;
		let daysSinceUsed: number | null = null;
		if (lastDay) {
			daysSinceUsed = Math.floor((now - new Date(lastDay).getTime()) / (1000 * 60 * 60 * 24));
		}

		stats.set(skill.name, {
			uses: skill.total,
			lastUsed: lastDay || null,
			daysSinceUsed,
			isStale: daysSinceUsed !== null && daysSinceUsed > 30,
			isHeavy: false,
			daily: skill.daily,
		});
	}
	return stats;
}

export function getSkillConflicts(): Map<string, { skillName: string; similarity: number }[]> {
	const conflicts = new Map<string, { skillName: string; similarity: number }[]>();
	if (!isSkillkitAvailable()) return conflicts;

	const data = runSkillkitJson("conflicts --dry-run") as {
		pairs?: { skill_a: string; skill_b: string; similarity: number }[];
	} | null;

	if (!data || !("pairs" in data)) return conflicts;

	for (const pair of (data as { pairs: { skill_a: string; skill_b: string; similarity: number }[] }).pairs) {
		if (!conflicts.has(pair.skill_a)) conflicts.set(pair.skill_a, []);
		if (!conflicts.has(pair.skill_b)) conflicts.set(pair.skill_b, []);
		conflicts.get(pair.skill_a)!.push({ skillName: pair.skill_b, similarity: pair.similarity });
		conflicts.get(pair.skill_b)!.push({ skillName: pair.skill_a, similarity: pair.similarity });
	}
	return conflicts;
}

export function getSkillTraces(skillName: string): { traceId: string; timestamp: string; tokens: number; cost: number; duration: number; model: string }[] {
	if (!isSkillkitAvailable()) return [];

	const data = runSkillkitJson(`trace --list --skill ${skillName} --limit 5`) as {
		trace_id: string; timestamp: string; tokens_total: number; cost_estimate: number; duration_ms: number; model: string;
	}[] | null;

	if (!Array.isArray(data)) return [];

	return data.map((t) => ({
		traceId: t.trace_id,
		timestamp: t.timestamp,
		tokens: t.tokens_total,
		cost: t.cost_estimate,
		duration: t.duration_ms,
		model: t.model || "unknown",
	}));
}

export function getSkillWarnings(): { oversized: { name: string; lines: number }[]; longDesc: { name: string; chars: number }[] } {
	if (!isSkillkitAvailable()) return { oversized: [], longDesc: [] };

	const data = runSkillkitJson("health") as {
		warnings?: { oversized: { name: string; lines: number }[]; long_descriptions: { name: string; chars: number }[] };
	} | null;

	if (!data?.warnings) return { oversized: [], longDesc: [] };
	return {
		oversized: data.warnings.oversized || [],
		longDesc: data.warnings.long_descriptions || [],
	};
}

export function runSkillkitAction(cmd: string): { success: boolean; output: string } {
	const bin = getSkillkitBin();
	if (!bin) return { success: false, output: "skillkit not found" };
	try {
		const out = execSync(`${bin} ${cmd}`, {
			encoding: "utf-8",
			timeout: 30000,
			env: { ...process.env, NO_COLOR: "1", PATH: buildPath() },
			stdio: ["pipe", "pipe", "pipe"],
		}).trim();
		return { success: true, output: out };
	} catch (e: unknown) { /* empty */
		return { success: false, output: e instanceof Error ? e.message : "unknown error" };
	}
}

export function formatLastUsed(lastUsed: string | null): string {
	if (!lastUsed) return "never";
	const ms = Date.now() - new Date(lastUsed).getTime();
	const mins = Math.floor(ms / 60000);
	if (mins < 60) return `${mins}m ago`;
	const hours = Math.floor(mins / 60);
	if (hours < 24) return `${hours}h ago`;
	const days = Math.floor(hours / 24);
	if (days < 30) return `${days}d ago`;
	return `${Math.floor(days / 30)}mo ago`;
}



export interface GeminiBurn {
	agent: string;
	cost: { total: number };
	period: { days: number; sessions: number; api_calls: number };
	tokens: { input: number; output: number; cache_creation: number; cache_read: number };
	by_day: { date: string; costUsd: number; apiCalls: number }[];
	by_model: { model: string; apiCalls: number; costUsd: number }[];
}

export function getGeminiBurn(): GeminiBurn {
	const fs = require("fs");
	const path = require("path");
	const home = require("os").homedir();
	const chatsDir = path.join(home, ".gemini-app", "tmp", "fredrikskauen", "chats");

	const burn: GeminiBurn = {
		agent: "Gemini CLI",
		cost: { total: 0 },
		period: { days: 30, sessions: 0, api_calls: 0 },
		tokens: { input: 0, output: 0, cache_creation: 0, cache_read: 0 },
		by_day: [],
		by_model: [],
	};

	if (!fs.existsSync(chatsDir)) return burn;

	const files = fs.readdirSync(chatsDir).filter((f: string) => f.endsWith(".json"));
	const now = Date.now();
	const thirtyDaysAgo = now - 30 * 24 * 60 * 60 * 1000;

	const dayMap = new Map<string, { cost: number; calls: number }>();
	const modelMap = new Map<string, { cost: number; calls: number }>();

	for (const file of files) {
		try {
			const filePath = path.join(chatsDir, file);
			const chat = JSON.parse(fs.readFileSync(filePath, "utf-8"));
			
			// Bruk startTime fra JSON hvis mulig, ellers filens mtime
			const startTime = chat.startTime ? new Date(chat.startTime) : fs.statSync(filePath).mtime;
			if (startTime.getTime() < thirtyDaysAgo) continue;

			burn.period.sessions++;
			const date = startTime.toISOString().split("T")[0];

			if (chat.messages) {
				chat.messages.forEach((msg: any) => {
					const isGemini = msg.type === "gemini" || msg.role === "model" || msg.role === "assistant";
					if (isGemini && msg.tokens) {
						burn.period.api_calls++;
						const t = msg.tokens;
						burn.tokens.input += t.input || 0;
						burn.tokens.output += t.output || 0;
						burn.tokens.cache_creation += t.cached || 0;

						// Estimer kostnad: $2 per million tokens i snitt
						const cost = ((t.input || 0) + (t.output || 0) + (t.cached || 0)) * 0.000002;
						burn.cost.total += cost;

						const day = dayMap.get(date) || { cost: 0, calls: 0 };
						day.cost += cost;
						day.calls++;
						dayMap.set(date, day);

						const model = msg.model || chat.model || "gemini-1.5-pro";
						const mod = modelMap.get(model) || { cost: 0, calls: 0 };
						mod.cost += cost;
						mod.calls++;
						modelMap.set(model, mod);
					}
				});
			}
		} catch (e) {}
	}

	burn.by_day = Array.from(dayMap.entries())
		.map(([date, data]) => ({ date, costUsd: data.cost, apiCalls: data.calls }))
		.sort((a, b) => a.date.localeCompare(b.date));

	burn.by_model = Array.from(modelMap.entries())
		.map(([model, data]) => ({ model, costUsd: data.cost, apiCalls: data.calls }))
		.sort((a, b) => b.costUsd - a.costUsd);

	return burn;
}

export function getGeminiContextTax(): GeminiContextTax {
	const fs = require('fs');
	const path = require('path');
	const home = require('os').homedir();
	const getTokens = (p: string) => fs.existsSync(p) ? Math.ceil(fs.statSync(p).size / 4) : 0;

	// Scan for CLAUDE.md files across global and project directories
	const SKIP_DIRS = new Set(["node_modules", ".Trash", "Library", "Applications", "Music", "Movies", "Pictures", "Public"]);
	let claudeMdTokens = getTokens(path.join(home, ".claude", "CLAUDE.md"));
	try {
		for (const entry of fs.readdirSync(home, { withFileTypes: true })) {
			if ((!entry.isDirectory() && !entry.isSymbolicLink()) || SKIP_DIRS.has(entry.name)) continue;
			const claudeMd = path.join(home, entry.name, "CLAUDE.md");
			claudeMdTokens += getTokens(claudeMd);
		}
	} catch { /* permission errors */ }

	return {
		claudeMd: claudeMdTokens,
		geminiMd: getTokens(path.join(home, "Documents", "MDVault", "GEMINI.md")),
		memory: getTokens(path.join(home, ".gemini-app", ".gemini", "GEMINI.md")),
		skillsMetadata: 500
	};
}

export function getClaudeCodeSkillUsage(): Map<string, number> {
	const skillMap = new Map<string, number>();
	const fs = require('fs');
	const path = require('path');
	const home = require('os').homedir();
	const projectsDir = path.join(home, ".claude", "projects");

	if (!fs.existsSync(projectsDir)) return skillMap;

	const now = Date.now();
	const thirtyDaysAgo = now - 30 * 24 * 60 * 60 * 1000;

	try {
		for (const project of fs.readdirSync(projectsDir)) {
			const projectPath = path.join(projectsDir, project);
			if (!fs.statSync(projectPath).isDirectory()) continue;
			for (const file of fs.readdirSync(projectPath).filter((f: string) => f.endsWith(".jsonl"))) {
				const filePath = path.join(projectPath, file);
				try {
					const lines = fs.readFileSync(filePath, "utf-8").split("\n");
					for (const line of lines) {
						if (!line.trim()) continue;
						try {
							const msg = JSON.parse(line);
							const timestamp = msg.timestamp;
							if (timestamp && new Date(timestamp).getTime() < thirtyDaysAgo) continue;
							const content = msg?.message?.content;
							if (!Array.isArray(content)) continue;
							for (const block of content) {
								if (block?.type === "tool_use" && block?.name === "Skill" && block?.input?.skill) {
									const name = block.input.skill;
									skillMap.set(name, (skillMap.get(name) || 0) + 1);
								}
							}
						} catch { /* skip malformed lines */ }
					}
				} catch { /* skip unreadable files */ }
			}
		}
	} catch { /* skip permission errors */ }

	return skillMap;
}

export interface ActivationModes {
	manual: number;
	auto: number;
}

function isManualActivation(userMsg: string, skillName: string): boolean {
	const lower = userMsg.toLowerCase();
	// Slash command (e.g. /commit)
	if (/^\/\w/.test(userMsg.trim())) return true;
	// Explicit skill name mention
	if (lower.includes(skillName.toLowerCase())) return true;
	// Common manual invocation phrases
	const manualPhrases = ["activate", "load the", "invoke", "use skill", "load skill", "use the skill", "bruk skill", "aktiver"];
	return manualPhrases.some(p => lower.includes(p));
}

export function getClaudeCodeActivationModes(): Map<string, ActivationModes> {
	const modeMap = new Map<string, ActivationModes>();
	const fs = require('fs');
	const path = require('path');
	const home = require('os').homedir();
	const projectsDir = path.join(home, ".claude", "projects");

	if (!fs.existsSync(projectsDir)) return modeMap;

	const now = Date.now();
	const thirtyDaysAgo = now - 30 * 24 * 60 * 60 * 1000;

	try {
		for (const project of fs.readdirSync(projectsDir)) {
			const projectPath = path.join(projectsDir, project);
			if (!fs.statSync(projectPath).isDirectory()) continue;
			for (const file of fs.readdirSync(projectPath).filter((f: string) => f.endsWith(".jsonl"))) {
				const filePath = path.join(projectPath, file);
				try {
					const lines = fs.readFileSync(filePath, "utf-8").split("\n");
					let lastUserMsg = "";
					for (const line of lines) {
						if (!line.trim()) continue;
						try {
							const msg = JSON.parse(line);
							const timestamp = msg.timestamp;
							if (timestamp && new Date(timestamp).getTime() < thirtyDaysAgo) continue;
							const role = msg?.message?.role;
							const content = msg?.message?.content;
							if (role === "user") {
								if (typeof content === "string") {
									lastUserMsg = content;
								} else if (Array.isArray(content)) {
									lastUserMsg = content.filter((b: any) => b?.type === "text").map((b: any) => b.text).join(" ");
								}
							} else if (role === "assistant" && Array.isArray(content)) {
								for (const block of content) {
									if (block?.type === "tool_use" && block?.name === "Skill" && block?.input?.skill) {
										const name = block.input.skill;
										const entry = modeMap.get(name) || { manual: 0, auto: 0 };
										if (isManualActivation(lastUserMsg, name)) entry.manual++;
										else entry.auto++;
										modeMap.set(name, entry);
									}
								}
							}
						} catch { /* skip malformed lines */ }
					}
				} catch { /* skip unreadable files */ }
			}
		}
	} catch { /* skip permission errors */ }

	return modeMap;
}

export function getGeminiSkillUsage(): Map<string, number> {
	const skillMap = new Map<string, number>();
	const fs = require('fs');
	const path = require('path');
	const home = require('os').homedir();
	const chatsDir = path.join(home, ".gemini-app", "tmp", "fredrikskauen", "chats");

	if (fs.existsSync(chatsDir)) {
		const files = fs.readdirSync(chatsDir).filter((f: string) => f.endsWith(".json"));
		for (const file of files) {
			try {
				const chat = JSON.parse(fs.readFileSync(path.join(chatsDir, file), "utf-8"));
				if (chat && chat.messages) {
					chat.messages.forEach((msg: any) => {
						if (msg.toolCalls) {
							msg.toolCalls.forEach((tc: any) => {
								if (tc.name === "activate_skill" && tc.args && tc.args.name) {
									const name = tc.args.name;
									skillMap.set(name, (skillMap.get(name) || 0) + 1);
								}
							});
						}
					});
				}
			} catch (e) {}
		}
	}
	return skillMap;
}

export interface KeywordCoverage {
	description: string;
	keywords: string[];
	hitKeywords: string[];
	missKeywords: string[];
	coveragePct: number;
}

const STOP_WORDS = new Set([
	"a","an","the","is","are","was","were","be","been","being","have","has","had",
	"do","does","did","will","would","could","should","may","might","must","shall",
	"can","need","used","use","uses","using","when","where","how","why","what",
	"which","who","this","that","these","those","and","or","but","if","of","in",
	"on","to","for","at","by","with","from","about","into","through","as","up",
	"also","just","not","no","only","some","any","all","both","more","most",
	"other","such","than","then","well","per","via","its","your","their",
	"help","helps","user","users","work","works","file","files","new","get",
	"set","run","add","edit","read","write","make","let","give","show","find",
	"them","they","their","you","our","we","data","type","list","item","each",
	"time","way","part","form","line","single","simple","basic","general",
	"specific","current","available","support","supports","include","includes",
	"provides","provide","allow","allows","create","creates","manage","manages"
]);

function extractKeywords(description: string): string[] {
	return [...new Set(
		description
			.toLowerCase()
			.replace(/[^a-z0-9\s-]/g, " ")
			.split(/\s+/)
			.filter(w => w.length >= 4 && !STOP_WORDS.has(w))
	)];
}

function parseSkillDescription(skillMd: string): string {
	const match = skillMd.match(/^---[\s\S]*?description:\s*["']?(.+?)["']?\s*\n[\s\S]*?---/m);
	return match ? match[1].trim() : "";
}

export function getSkillKeywordCoverage(): Map<string, KeywordCoverage> {
	const fs = require("fs");
	const path = require("path");
	const home = require("os").homedir();
	const skillsDir = path.join(home, ".claude", "skills");
	const projectsDir = path.join(home, ".claude", "projects");
	const result = new Map<string, KeywordCoverage>();

	// Read skill descriptions
	const descriptions = new Map<string, string>();
	if (fs.existsSync(skillsDir)) {
		for (const skillName of fs.readdirSync(skillsDir)) {
			const skillMdPath = path.join(skillsDir, skillName, "SKILL.md");
			if (!fs.existsSync(skillMdPath)) continue;
			try {
				const desc = parseSkillDescription(fs.readFileSync(skillMdPath, "utf-8"));
				if (desc) descriptions.set(skillName, desc);
			} catch { /* skip */ }
		}
	}
	if (descriptions.size === 0) return result;

	// Collect user messages per skill activation (last 30d)
	const activationMessages = new Map<string, string[]>();
	const now = Date.now();
	const thirtyDaysAgo = now - 30 * 24 * 60 * 60 * 1000;

	if (fs.existsSync(projectsDir)) {
		try {
			for (const project of fs.readdirSync(projectsDir)) {
				const projectPath = path.join(projectsDir, project);
				if (!fs.statSync(projectPath).isDirectory()) continue;
				for (const file of fs.readdirSync(projectPath).filter((f: string) => f.endsWith(".jsonl"))) {
					try {
						const lines = fs.readFileSync(path.join(projectPath, file), "utf-8").split("\n");
						let lastUserMsg = "";
						for (const line of lines) {
							if (!line.trim()) continue;
							try {
								const msg = JSON.parse(line);
								if (msg.timestamp && new Date(msg.timestamp).getTime() < thirtyDaysAgo) continue;
								const role = msg?.message?.role;
								const content = msg?.message?.content;
								if (role === "user") {
									lastUserMsg = typeof content === "string"
										? content
										: Array.isArray(content) ? content.filter((b: any) => b?.type === "text").map((b: any) => b.text).join(" ") : "";
								} else if (role === "assistant" && Array.isArray(content)) {
									for (const block of content) {
										if (block?.type === "tool_use" && block?.name === "Skill" && block?.input?.skill) {
											const name = block.input.skill;
											if (!activationMessages.has(name)) activationMessages.set(name, []);
											if (lastUserMsg) activationMessages.get(name)!.push(lastUserMsg.toLowerCase());
										}
									}
								}
							} catch { /* skip */ }
						}
					} catch { /* skip */ }
				}
			}
		} catch { /* skip */ }
	}

	// Build coverage per skill that has both a description and activations
	for (const [skillName, desc] of descriptions) {
		const msgs = activationMessages.get(skillName);
		if (!msgs || msgs.length === 0) continue;
		const keywords = extractKeywords(desc);
		if (keywords.length === 0) continue;
		const combined = msgs.join(" ");
		const hitKeywords = keywords.filter(kw => combined.includes(kw));
		const missKeywords = keywords.filter(kw => !combined.includes(kw));
		result.set(skillName, {
			description: desc,
			keywords,
			hitKeywords,
			missKeywords,
			coveragePct: Math.round((hitKeywords.length / keywords.length) * 100),
		});
	}

	return result;
}

export interface SkillUpdateInfo {
	name: string;
	updatedAt: Date;
}

export function getRecentlyUpdatedSkills(days = 30): SkillUpdateInfo[] {
	const fs = require("fs");
	const path = require("path");
	const home = require("os").homedir();
	const skillsDir = path.join(home, ".claude", "skills");
	const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
	const result: SkillUpdateInfo[] = [];

	if (!fs.existsSync(skillsDir)) return result;

	for (const skillName of fs.readdirSync(skillsDir)) {
		const skillMdPath = path.join(skillsDir, skillName, "SKILL.md");
		if (!fs.existsSync(skillMdPath)) continue;
		try {
			const mtime = fs.statSync(skillMdPath).mtime as Date;
			if (mtime.getTime() >= cutoff) {
				result.push({ name: skillName, updatedAt: mtime });
			}
		} catch { /* skip */ }
	}

	return result.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
}

const UPDATE_LOG_FILE = join(homedir(), ".skillkit", "skill-update-log.json");

export function snapshotSkillMtimes(): Map<string, number> {
	const fs = require("fs");
	const path = require("path");
	const skillsDir = path.join(homedir(), ".claude", "skills");
	const snap = new Map<string, number>();
	if (!fs.existsSync(skillsDir)) return snap;
	for (const skillName of fs.readdirSync(skillsDir)) {
		const p = path.join(skillsDir, skillName, "SKILL.md");
		if (fs.existsSync(p)) snap.set(skillName, fs.statSync(p).mtimeMs);
	}
	return snap;
}

export function logSkillUpdates(before: Map<string, number>): void {
	const fs = require("fs");
	const path = require("path");
	const skillsDir = path.join(homedir(), ".claude", "skills");
	if (!fs.existsSync(skillsDir)) return;

	const updated: string[] = [];
	for (const skillName of fs.readdirSync(skillsDir)) {
		const p = path.join(skillsDir, skillName, "SKILL.md");
		if (!fs.existsSync(p)) continue;
		const newMtime = fs.statSync(p).mtimeMs;
		const oldMtime = before.get(skillName);
		if (oldMtime === undefined || newMtime > oldMtime) updated.push(skillName);
	}
	if (updated.length === 0) return;

	let log: { date: string; skills: string[] }[] = [];
	try { log = JSON.parse(fs.readFileSync(UPDATE_LOG_FILE, "utf-8")); } catch { /* empty */ }
	const today = new Date().toISOString().split("T")[0];
	const existing = log.find(e => e.date === today);
	if (existing) {
		existing.skills = [...new Set([...existing.skills, ...updated])];
	} else {
		log.push({ date: today, skills: updated });
	}
	// Keep last 90 days
	const cutoff = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString().split("T")[0];
	log = log.filter(e => e.date >= cutoff);
	try { fs.writeFileSync(UPDATE_LOG_FILE, JSON.stringify(log, null, 2), "utf-8"); } catch { /* empty */ }
}

export interface UpdateLogEntry {
	date: string;
	skills: string[];
}

export function getSkillUpdateLog(days = 30): UpdateLogEntry[] {
	const fs = require("fs");
	const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().split("T")[0];
	try {
		const log: UpdateLogEntry[] = JSON.parse(fs.readFileSync(UPDATE_LOG_FILE, "utf-8"));
		return log.filter(e => e.date >= cutoff).sort((a, b) => b.date.localeCompare(a.date));
	} catch { return []; }
}

const MTIME_SNAPSHOT_FILE = join(homedir(), ".skillkit", "skill-mtime-snapshot.json");

export function checkAndLogSkillChanges(): void {
	const fs = require("fs");
	const path = require("path");
	const skillsDir = path.join(homedir(), ".claude", "skills");
	if (!fs.existsSync(skillsDir)) return;

	// Load previous snapshot
	let prev: Record<string, number> = {};
	try { prev = JSON.parse(fs.readFileSync(MTIME_SNAPSHOT_FILE, "utf-8")); } catch { /* first run */ }

	// Read current mtimes
	const current: Record<string, number> = {};
	for (const skillName of fs.readdirSync(skillsDir)) {
		const p = path.join(skillsDir, skillName, "SKILL.md");
		if (fs.existsSync(p)) current[skillName] = fs.statSync(p).mtimeMs;
	}

	// Find changed or new skills (skip if no previous snapshot — first run, just save)
	const hasPrev = Object.keys(prev).length > 0;
	if (hasPrev) {
		const changed = Object.entries(current)
			.filter(([name, mtime]) => prev[name] === undefined || mtime > prev[name])
			.map(([name]) => name);

		if (changed.length > 0) {
			let log: { date: string; skills: string[] }[] = [];
			try { log = JSON.parse(fs.readFileSync(UPDATE_LOG_FILE, "utf-8")); } catch { /* empty */ }
			const today = new Date().toISOString().split("T")[0];
			const existing = log.find(e => e.date === today);
			if (existing) {
				existing.skills = [...new Set([...existing.skills, ...changed])];
			} else {
				log.push({ date: today, skills: changed });
			}
			const cutoff = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString().split("T")[0];
			log = log.filter(e => e.date >= cutoff);
			try { fs.writeFileSync(UPDATE_LOG_FILE, JSON.stringify(log, null, 2), "utf-8"); } catch { /* empty */ }
		}
	}

	// Save current snapshot
	try { fs.writeFileSync(MTIME_SNAPSHOT_FILE, JSON.stringify(current, null, 2), "utf-8"); } catch { /* empty */ }
}
