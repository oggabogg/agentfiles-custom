import { Notice, setIcon, type App } from "obsidian";
import { shell } from "electron";
import * as skillkit from "../skillkit";
import { updateAllSkillsAsync } from "../marketplace";
import { showConfirmModal } from "./confirm-modal";

interface StatsJson {
	period: { days: number };
	total_invocations: number;
	unique_skills: number;
	most_active_day: string;
	streak?: { current: number; longest: number };
	velocity?: { this_week: number; last_week: number; change_pct: number };
	top_skills: { name: string; total: number; daily: { date: string; count: number }[] }[];
}

interface HealthJson {
	installed: number;
	agents: string[];
	db: { exists: boolean; events: number };
	usage: { used_30d: number; unused_30d: number; never_used: string[] };
	metadata: { total_chars: number; budget: number; pct: number };
	content: { total_chars: number };
	warnings: { oversized: { name: string; lines: number }[]; long_descriptions: { name: string; chars: number }[] };
}

interface BurnAgent {
	agent: string;
	cost: { total: number };
	period: { days: number; sessions: number; api_calls: number };
	by_day: { date: string; costUsd: number }[];
	by_model: { model: string; apiCalls: number; costUsd: number }[];
}

interface ContextJson {
	always_loaded: { total_tokens: number; claude_md_tokens: number; skill_metadata_tokens: number; memory_tokens: number; gemini_md_tokens: number };
	cost_per_call: { first_call_cache_write: number; subsequent_cache_read: number };
	session_estimate: { with_cache: number; without_cache: number; savings_pct: number };
	sources: { name: string; tokens: number }[];
}

interface DashboardData {
	stats: StatsJson | null;
	health: HealthJson | null;
	burns: BurnAgent[];
	context: ContextJson | null;
}

function enrichDataWithGemini(data: DashboardData): void {
	const geminiTax = skillkit.getGeminiContextTax();
	const geminiUsage = skillkit.getGeminiSkillUsage();
	const claudeUsage = skillkit.getClaudeCodeSkillUsage();
	const geminiBurn = skillkit.getGeminiBurn();

	// Merge Claude Code skill usage into geminiUsage so downstream logic handles both
	claudeUsage.forEach((count, name) => {
		geminiUsage.set(name, (geminiUsage.get(name) || 0) + count);
	});

	// Migrer fra singular 'burn' til 'burns' array for gammel cache-kompatibilitet
	if (!data.burns) {
		const oldBurn = (data as any).burn;
		data.burns = oldBurn ? [oldBurn] : [];
	}

	// Legg til Gemini i burns hvis den ikke er der allerede
	if (!data.burns.find(b => b && b.agent === "Gemini CLI")) {
		data.burns.push(geminiBurn);
	}

	if (data.context) {
		const claudeBurn = data.burns.find(b => b.agent === "Claude Code");
		
		data.context.always_loaded.memory_tokens = geminiTax.memory || 0;
		data.context.always_loaded.gemini_md_tokens = geminiTax.geminiMd || 0;
		// Prefer direct file-read (geminiTax.claudeMd), fall back to skillkit's own
		// claude_md_tokens calculation (which scans all loaded CLAUDE.md sources).
		// Never overwrite with 0 if skillkit already has a real value.
		if (geminiTax.claudeMd > 0) {
			data.context.always_loaded.claude_md_tokens = geminiTax.claudeMd;
		} else if (!data.context.always_loaded.claude_md_tokens) {
			data.context.always_loaded.claude_md_tokens = 0;
		}
		
		// Vi legger til tokens brukt i denne perioden for å vise "tax" mer dynamisk hvis ønskelig, 
		// men for nå holder vi oss til de "always loaded" tokens som før.
		data.context.always_loaded.total_tokens = 
			data.context.always_loaded.claude_md_tokens + 
			data.context.always_loaded.gemini_md_tokens + 
			data.context.always_loaded.memory_tokens + 
			data.context.always_loaded.skill_metadata_tokens || 500;
	}

	if (data.stats && data.stats.top_skills) {
		// Filter ut kjerne-verktøy fra skillkit-data
		data.stats.top_skills = data.stats.top_skills.filter(s => !DashboardPanel.CORE_TOOLS.has(s.name));

		geminiUsage.forEach((count, name) => {
			const existing = data.stats.top_skills.find(s => s.name === name);
			if (existing) existing.total += count;
			else if (!DashboardPanel.CORE_TOOLS.has(name)) {
				data.stats!.top_skills.push({ name, total: count, daily: [] });
			}
		});
		data.stats.top_skills.sort((a, b) => b.total - a.total);
	}

	if (data.health) {
		// Rens never_used for kjerne-verktøy (hvis skillkit har plukket dem opp)
		data.health.usage.never_used = data.health.usage.never_used.filter(name => !DashboardPanel.CORE_TOOLS.has(name));

		// Finn unike brukte skills fra Gemini som ikke er kjerne-verktøy
		geminiUsage.forEach((count, name) => {
			if (count > 0 && !DashboardPanel.CORE_TOOLS.has(name)) {
				const idx = data.health!.usage.never_used.indexOf(name);
				if (idx !== -1) {
					data.health!.usage.never_used.splice(idx, 1);
					data.health!.usage.used_30d++;
				}
			}
		});
		// Oppdater unused_30d (som er de som aldri er trigget)
		data.health.usage.unused_30d = data.health.usage.never_used.length;

		// Juster metadata-budsjett for Gemini CLI (standard skillkit budsjett på 16k er altfor lavt for Gemini)
		// Gemini støtter 32k tokens i system instructions, 100k tegn er et trygt anslag (~25k tokens)
		data.health.metadata.budget = 100000;
		data.health.metadata.pct = Math.round((data.health.metadata.total_chars / data.health.metadata.budget) * 100);
	}
}

function loadData(): DashboardData {
	const stats = skillkit.runSkillkitJson("stats") as StatsJson | null;
	const health = skillkit.runSkillkitJson("health") as HealthJson | null;
	const burnRaw = skillkit.runSkillkitJson("burn");
	let context = skillkit.runSkillkitJson("context") as ContextJson | null;

	const burns: BurnAgent[] = [];
	if (burnRaw) {
		if (Array.isArray(burnRaw)) {
			burns.push(...burnRaw);
		} else {
			burns.push(burnRaw as BurnAgent);
		}
	}

	if (!context) {
		context = {
			always_loaded: { total_tokens: 0, claude_md_tokens: 0, skill_metadata_tokens: 500, memory_tokens: 0, gemini_md_tokens: 0 },
			cost_per_call: { first_call_cache_write: 0, subsequent_cache_read: 0 },
			session_estimate: { with_cache: 0, without_cache: 0, savings_pct: 0 },
			sources: []
		};
	}

	const data = {
		stats,
		health,
		burns,
		context,
	};

	enrichDataWithGemini(data);
	return data;
}

import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";

const CACHE_FILE = join(homedir(), ".skillkit", "dashboard-cache.json");

let cachedData: DashboardData | null = null;
let cachedAt: number | null = null;

function loadDiskCache(): void {
	if (cachedData) return;
	if (!existsSync(CACHE_FILE)) return;
	try {
		const raw = JSON.parse(readFileSync(CACHE_FILE, "utf-8"));
		cachedData = raw.data;
		cachedAt = raw.cachedAt;
	} catch { /* empty */ }
}

function saveDiskCache(): void {
	if (!cachedData) return;
	try {
		writeFileSync(CACHE_FILE, JSON.stringify({ data: cachedData, cachedAt }, null, 2), "utf-8");
	} catch { /* empty */ }
}

loadDiskCache();

export class DashboardPanel {
	private containerEl: HTMLElement;
	private app: App;

	constructor(containerEl: HTMLElement, app: App) {
		this.containerEl = containerEl;
		this.app = app;
	}

	render(): void {
		this.containerEl.empty();
		this.containerEl.addClass("as-dashboard");

		if (!skillkit.isSkillkitAvailable()) {
			this.renderNoSkillkit();
			return;
		}

		try {
			if (cachedData) {
				enrichDataWithGemini(cachedData);
				this.renderDashboard(cachedData);
			} else {
				const loading = this.containerEl.createDiv("as-dash-loading");
				loading.createDiv("as-dash-spinner");
				loading.createDiv({ cls: "as-dash-loading-text", text: "Loading analytics..." });

				setTimeout(() => {
					try {
						const data = loadData();
						cachedData = data;
						cachedAt = Date.now();
						saveDiskCache();
						loading.remove();
						this.renderDashboard(data);
					} catch (e) {
						loading.remove();
						this.renderError(e);
					}
				}, 10);
			}
		} catch (e) {
			this.renderError(e);
		}
	}

	private renderError(e: any): void {
		const error = this.containerEl.createDiv("as-dash-error");
		error.createEl("h3", { text: "Error loading dashboard" });
		error.createEl("pre", { text: String(e.stack || e) });
		const btn = error.createEl("button", { text: "Retry" });
		btn.addEventListener("click", () => {
			cachedData = null;
			this.render();
		});
	}

	public static CORE_TOOLS = new Set([
		"run_shell_command",
		"read_file",
		"read_many_files",
		"write_file",
		"replace",
		"list_directory",
		"glob",
		"grep_search",
		"web_fetch",
		"google_web_search",
		"ask_user",
		"enter_plan_mode",
		"exit_plan_mode",
		"write_todos",
		"get_internal_docs",
		"codebase_investigator",
		"cli_help",
		"generalist",
		"activate_skill",
		"save_memory"
	]);


	private renderDashboard(data: DashboardData): void {
		this.renderActionBar(data);
		if (data.stats) this.renderOverview(data.stats, data.health);
		if (data.stats) this.renderTopSkills(data.stats);
		if (data.health || data.context) {
			const row = this.containerEl.createDiv("as-dash-row");
			if (data.health) this.renderHealth(data.health, row);
			if (data.context) this.renderContext(data.context, row);
		}
		
		const burns = data.burns || [];
		for (const burn of burns) {
			if (burn) this.renderBurn(burn);
		}

		if (data.health) this.renderStale(data.health);
	}

	private renderActionBar(data: DashboardData): void {
		const bar = this.containerEl.createDiv("as-dash-action-bar");

		if (cachedAt) {
			const ago = Math.round((Date.now() - cachedAt) / 1000);
			const label = ago < 5 ? "just now" : ago < 60 ? `${ago}s ago` : `${Math.round(ago / 60)}m ago`;
			bar.createSpan({ cls: "as-dash-updated", text: `Updated ${label}` });
		}

		const buttons = bar.createDiv("as-dash-action-buttons");

		const updateBtn = buttons.createEl("button", { cls: "as-action-btn", text: "Update skills" });
		updateBtn.addEventListener("click", () => {
			updateBtn.setText("Updating...");
			updateBtn.disabled = true;
			void updateAllSkillsAsync().then((result) => {
				if (result.success) {
					const msg = result.count > 0 ? `Updated ${result.count} skill(s)` : "All skills up to date";
					new Notice(msg, 5000);
					cachedData = null;
					cachedAt = null;
					this.render();
				} else {
					new Notice(`Update failed: ${result.output}`, 5000);
				}
				updateBtn.setText("Update skills");
				updateBtn.disabled = false;
			});
		});

		const scanBtn = buttons.createEl("button", { cls: "as-action-btn", text: "Scan sessions" });
		scanBtn.addEventListener("click", () => {
			scanBtn.setText("Scanning...");
			scanBtn.disabled = true;
			setTimeout(() => {
				const result = skillkit.runSkillkitAction("scan");
				if (result.success) {
					new Notice("Scan complete", 5000);
					cachedData = null;
					cachedAt = null;
					this.render();
				} else {
					new Notice(`Scan failed: ${result.output}`, 5000);
				}
				scanBtn.setText("Scan sessions");
				scanBtn.disabled = false;
			}, 10);
		});

		if (data.health && data.health.usage.unused_30d > 0) {
			const pruneBtn = buttons.createEl("button", { cls: "as-action-btn as-action-btn-danger", text: `Prune ${data.health.usage.unused_30d} stale` });
			pruneBtn.addEventListener("click", () => {
				showConfirmModal(this.app, "Prune stale skills", `Remove ${data.health!.usage.unused_30d} unused skills? This cannot be undone.`, () => {
					pruneBtn.setText("Pruning...");
					pruneBtn.disabled = true;
					setTimeout(() => {
						const result = skillkit.runSkillkitAction("prune --yes");
						if (result.success) {
							new Notice("Pruned stale skills", 5000);
							cachedData = null;
							cachedAt = null;
							this.render();
						} else {
							new Notice(`Prune failed: ${result.output}`, 5000);
						}
						pruneBtn.setText(`Prune ${data.health!.usage.unused_30d} stale`);
						pruneBtn.disabled = false;
					}, 10);
				});
			});
		}
	}

	private renderNoSkillkit(): void {
		const empty = this.containerEl.createDiv("as-dash-empty");
		const iconEl = empty.createDiv("as-dash-empty-icon");
		setIcon(iconEl, "bar-chart-2");
		empty.createEl("h3", { text: "Dashboard requires skillkit" });
		empty.createEl("p", { text: "Install skillkit to unlock usage analytics, burn rate, context tax, and more." });
		const cmd = empty.createDiv("as-dash-install-cmd");
		cmd.createEl("code", { text: "npm i -g @crafter/skillkit && skillkit scan" });
		const link = empty.createEl("a", {
			cls: "as-skillkit-link",
			text: "Learn more",
			href: "https://www.npmjs.com/package/@crafter/skillkit",
		});
		link.addEventListener("click", (e) => {
			e.preventDefault();
			void shell.openExternal("https://www.npmjs.com/package/@crafter/skillkit");
		});
	}

	private renderOverview(stats: StatsJson, health: HealthJson | null): void {
		const section = this.containerEl.createDiv("as-dash-section");
		section.createDiv({ cls: "as-dash-title", text: "Overview" });

		const grid = section.createDiv("as-dash-stats");
		this.statCard(grid, String(stats.total_invocations), "invocations", "activity");
		this.statCard(grid, String(stats.unique_skills), "active skills", "sparkles");
		this.statCard(grid, String(health?.installed ?? 0), "installed", "package");
		this.statCard(grid, String(health?.usage.unused_30d ?? 0), "stale", "alert-triangle");

		if (stats.streak && stats.streak.current > 0) {
			const streakRow = section.createDiv("as-dash-streak-row");
			streakRow.createSpan({ cls: "as-streak-value", text: `${stats.streak.current} day streak` });
			if (stats.streak.current >= 7) {
				streakRow.createSpan({ cls: "as-streak-fire", text: "on fire" });
			}
			streakRow.createSpan({ cls: "as-streak-longest", text: `longest: ${stats.streak.longest}d` });
		}

		if (stats.velocity && stats.velocity.this_week > 0) {
			const velRow = section.createDiv("as-dash-velocity-row");
			velRow.createSpan({ text: `This week: $${stats.velocity.this_week.toFixed(0)}` });
			velRow.createSpan({ cls: "as-velocity-vs", text: `vs $${stats.velocity.last_week.toFixed(0)} last week` });
			const changePct = stats.velocity.change_pct;
			const changeClass = changePct > 0 ? "as-velocity-up" : changePct < 0 ? "as-velocity-down" : "";
			const changeSign = changePct > 0 ? "+" : "";
			velRow.createSpan({ cls: `as-velocity-change ${changeClass}`, text: `${changeSign}${changePct.toFixed(0)}%` });
		}
	}

	private statCard(container: HTMLElement, value: string, label: string, icon: string): void {
		const card = container.createDiv("as-stat-card");
		const iconEl = card.createDiv("as-stat-icon");
		setIcon(iconEl, icon);
		card.createDiv({ cls: "as-stat-value", text: value });
		card.createDiv({ cls: "as-stat-label", text: label });
	}

	private renderTopSkills(stats: StatsJson): void {
		if (stats.top_skills.length === 0) return;
		const section = this.containerEl.createDiv("as-dash-section");
		section.createDiv({ cls: "as-dash-title", text: `Top Skills (${stats.period.days}d)` });

		const maxUses = stats.top_skills[0]?.total || 1;
		const list = section.createDiv("as-dash-bars");

		for (const skill of stats.top_skills.slice(0, 10)) {
			const row = list.createDiv("as-bar-row");
			row.createSpan({ cls: "as-bar-name", text: skill.name });
			const barWrap = row.createDiv("as-bar-wrap");
			const bar = barWrap.createDiv("as-bar-fill");
			bar.setCssProps({ "--bar-w": `${(skill.total / maxUses) * 100}%` });
			row.createSpan({ cls: "as-bar-count", text: String(skill.total) });
		}
	}

	private renderHealth(health: HealthJson, parent?: HTMLElement): void {
		const section = (parent || this.containerEl).createDiv("as-dash-section");
		section.createDiv({ cls: "as-dash-title", text: "Health" });

		const total = health.usage.used_30d + health.usage.unused_30d;
		const usedPct = total > 0 ? Math.round((health.usage.used_30d / total) * 100) : 0;

		const row = section.createDiv("as-dash-health-row");

		const donut = row.createDiv("as-donut");
		donut.setCssProps({ "--pct": `${usedPct}` });
		donut.createDiv({ cls: "as-donut-label", text: `${usedPct}%` });
		donut.createDiv({ cls: "as-donut-sub", text: "active" });

		const details = row.createDiv("as-health-details");
		details.createDiv({ cls: "as-health-line", text: `${health.usage.used_30d} used in 30d` });
		details.createDiv({ cls: "as-health-line as-health-warn", text: `${health.usage.unused_30d} never triggered` });

		const budgetBar = details.createDiv("as-budget-bar");
		const fill = budgetBar.createDiv("as-budget-fill");
		fill.setCssProps({ "--bar-w": `${health.metadata.pct}%` });
		if (health.metadata.pct > 80) fill.addClass("as-budget-over");
		details.createDiv({ cls: "as-health-line", text: `Metadata budget: ${health.metadata.pct}%` });
	}

	private renderBurn(burn: BurnAgent): void {
		const section = this.containerEl.createDiv("as-dash-section");
		section.createDiv({ cls: "as-dash-title", text: `Burn Rate — ${burn.agent} (${burn.period.days}d)` });

		const stats = section.createDiv("as-dash-stats as-dash-stats-sm");
		const totalCost = burn.cost.total < 1 && burn.cost.total > 0 ? burn.cost.total.toFixed(2) : Math.round(burn.cost.total).toLocaleString();
		const dailyAvg = (burn.cost.total / (burn.period.days || 1));
		const dailyAvgStr = dailyAvg < 1 && dailyAvg > 0 ? dailyAvg.toFixed(2) : Math.round(dailyAvg).toLocaleString();

		this.statCard(stats, `$${totalCost}`, "total cost", "flame");
		this.statCard(stats, `$${dailyAvgStr}`, "daily avg", "trending-up");
		this.statCard(stats, `${(burn.period.sessions || 0).toLocaleString()}`, "sessions", "terminal");
		
		const apiCalls = burn.period.api_calls;
		const apiCallsStr = apiCalls >= 1000 ? `${(apiCalls / 1000).toFixed(1)}k` : String(apiCalls);
		this.statCard(stats, apiCallsStr, "API calls", "zap");

		if (burn.by_model && burn.by_model.length > 0) {
			const models = section.createDiv("as-model-breakdown");
			for (const m of burn.by_model.slice(0, 4)) {
				const row = models.createDiv("as-model-row");
				row.createSpan({ cls: "as-model-name", text: m.model });
				row.createSpan({ cls: "as-model-calls", text: `${m.apiCalls.toLocaleString()} calls` });
				if (m.costUsd > 0) {
					const mCost = m.costUsd < 1 ? m.costUsd.toFixed(2) : Math.round(m.costUsd).toLocaleString();
					row.createSpan({ cls: "as-model-cost", text: `$${mCost}` });
				}
			}
		}

		const last14 = burn.by_day.slice(-14);
		if (last14.length === 0) return;

		const useCalls = burn.cost.total === 0;
		const maxValue = Math.max(...last14.map((d) => useCalls ? d.apiCalls : d.costUsd), 1);
		const chart = section.createDiv("as-burn-chart");

		for (const day of last14) {
			const col = chart.createDiv("as-burn-col");
			const bar = col.createDiv("as-burn-bar");
			const val = useCalls ? day.apiCalls : day.costUsd;
			const height = Math.max(2, (val / maxValue) * 100);
			bar.setCssProps({ "--bar-h": `${height}%` });
			const costStr = day.costUsd < 1 && day.costUsd > 0 ? day.costUsd.toFixed(2) : day.costUsd.toFixed(0);
			bar.title = `${day.date}: ${useCalls ? day.apiCalls + " calls" : "$" + costStr}`;
			col.createDiv({ cls: "as-burn-date", text: day.date.slice(8) });
		}
	}

	private renderContext(ctx: ContextJson, parent?: HTMLElement): void {
		const section = (parent || this.containerEl).createDiv("as-dash-section");
		section.createDiv({ cls: "as-dash-title", text: "Context Tax" });

		const total = ctx.always_loaded.total_tokens;
		const segments = [
			{ label: "CLAUDE.md", tokens: ctx.always_loaded.claude_md_tokens, cls: "as-ctx-claude" },
			{ label: "GEMINI.md", tokens: ctx.always_loaded.gemini_md_tokens, cls: "as-ctx-claude" },
			{ label: "Memory", tokens: ctx.always_loaded.memory_tokens, cls: "as-ctx-memory" },
			{ label: "Skills metadata", tokens: ctx.always_loaded.skill_metadata_tokens, cls: "as-ctx-skills" },
		];

		const fmtTokens = (t: number) => t >= 100 ? `${(t / 1000).toFixed(1)}k` : `${t}`;

		const bar = section.createDiv("as-ctx-bar");
		for (const seg of segments) {
			const part = bar.createDiv(`as-ctx-part ${seg.cls}`);
			part.setCssProps({ "--bar-w": `${(seg.tokens / total) * 100}%` });
			part.title = `${seg.label}: ${fmtTokens(seg.tokens)} tokens`;
		}

		const legend = section.createDiv("as-ctx-legend");
		for (const seg of segments) {
			const item = legend.createDiv("as-ctx-legend-item");
			item.createSpan({ cls: `as-ctx-dot ${seg.cls}` });
			item.createSpan({ text: `${seg.label}: ${fmtTokens(seg.tokens)}` });
		}

		const costs = section.createDiv("as-ctx-costs");
		costs.createDiv({ text: `Per session (cached): $${ctx.session_estimate.with_cache.toFixed(2)}` });
		costs.createDiv({ text: `Without cache: $${ctx.session_estimate.without_cache.toFixed(2)}` });
		costs.createDiv({ cls: "as-ctx-savings", text: `Cache saves ${ctx.session_estimate.savings_pct.toFixed(0)}%` });
	}

	private renderStale(health: HealthJson): void {
		if (health.usage.never_used.length === 0) return;
		const section = this.containerEl.createDiv("as-dash-section");
		section.createDiv({ cls: "as-dash-title", text: `Stale skills (${health.usage.unused_30d})` });

		const list = section.createDiv("as-stale-list");
		for (const name of health.usage.never_used.slice(0, 20)) {
			const item = list.createDiv("as-stale-item");
			item.createSpan({ text: name });
		}

		if (health.usage.never_used.length > 20) {
			list.createDiv({
				cls: "as-stale-more",
				text: `+${health.usage.never_used.length - 20} more`,
			});
		}
	}
}
