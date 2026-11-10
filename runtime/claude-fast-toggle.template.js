/* mirasim-claude-fast-toggle:v1 */
const MirasimClaudeSettingsQueueV4 = new WeakMap();
const MirasimClaudeFastSavesV4 = new WeakMap();

// Both Claude switches receive the same agentDefaults frame type. Serialize
// their writes per connection so one switch cannot consume the other's reply.
function MirasimClaudeSettingsRequestV4(client, ...args) {
  const previous = MirasimClaudeSettingsQueueV4.get(client) || Promise.resolve();
  const operation = previous.then(() => __REQUEST__(client, ...args));
  const settled = operation.then(() => undefined, () => undefined);
  MirasimClaudeSettingsQueueV4.set(client, settled);
  settled.then(() => {
    if (MirasimClaudeSettingsQueueV4.get(client) === settled) MirasimClaudeSettingsQueueV4.delete(client);
  });
  return operation;
}

function MirasimClaudeFastSaveStateV4(client) {
  if (!client || (typeof client !== "object" && typeof client !== "function")) return null;
  let state = MirasimClaudeFastSavesV4.get(client);
  if (!state) {
    state = { pending: null, listeners: new Set() };
    MirasimClaudeFastSavesV4.set(client, state);
  }
  return state;
}

function MirasimClaudeFastNotifyV4(state, pending) {
  state.pending = pending;
  for (const listener of state.listeners) listener(pending);
}

function MirasimClaudeFastToggleV4({ agent, disabled = false }) {
  const host = __CONTEXT__();
  const client = host.session?.client;
  const toast = __STORE__(state => state.toast);
  const catalog = __STORE__(state => state.catalogs[agent]);
  const locale = __STORE__(state => state.locale);
  const chinese = !locale || String(locale).toLowerCase().startsWith("zh");
  const ready = typeof catalog?.fastMode === "boolean";
  const current = catalog?.fastMode === true;
  const saveState = MirasimClaudeFastSaveStateV4(client);
  const [pending, setPending] = __REACT__.useState(saveState?.pending ?? null);

  __REACT__.useEffect(() => {
    setPending(saveState?.pending ?? null);
    if (!saveState) return;
    saveState.listeners.add(setPending);
    return () => saveState.listeners.delete(setPending);
  }, [saveState]);

  __REACT__.useEffect(() => {
    if (agent === "claude" && client && !ready) {
      try { client.post({ type: "getCatalog", agent }); } catch (_) {}
    }
  }, [agent, client, ready]);

  const enabled = pending ?? current;
  const busy = pending !== null;
  const scope = chinese ? "Claude 全局 · 下轮生效" : "Claude default · Next turn";
  const meaning = chinese
    ? "快速响应，与推理强度和 Ultracode 分别控制"
    : "Faster responses, independent of reasoning effort and Ultracode";
  const stateLabel = enabled ? "ON" : "OFF";

  const toggle = async () => {
    if (agent !== "claude" || disabled || !client || !ready ||
        !saveState || saveState.pending !== null) return;
    const next = !current;
    MirasimClaudeFastNotifyV4(saveState, next);
    try {
      const reply = await MirasimClaudeSettingsRequestV4(client,
        { type: "setAgentDefaults", agent: "claude", fastMode: next },
        "agentDefaults", {
          match: frame => frame.agent === "claude" &&
            typeof frame.fastMode === "boolean" && frame.fastMode === next,
        });
      __STORE__.setState(state => ({
        catalogs: {
          ...state.catalogs,
          claude: { ...state.catalogs.claude, fastMode: reply.fastMode },
        },
      }));
      try { client.post({ type: "getCatalog", agent: "claude" }); }
      catch (_) {
        toast?.(chinese ? "Fast 已保存；暂时无法刷新状态。" : "Fast saved; its state could not be refreshed.", false);
      }
    } catch (error) {
      toast?.((chinese ? "Fast 保存失败：" : "Could not save Fast: ") +
        (error instanceof Error ? error.message : String(error)), false);
      try { client.post({ type: "getCatalog", agent: "claude" }); } catch (_) {}
    } finally {
      MirasimClaudeFastNotifyV4(saveState, null);
    }
  };

  if (agent !== "claude") return null;
  return __JSX__.jsx("div", {
    "data-mirasim-fast-toggle": "v1",
    "data-fast-mode": enabled ? "true" : "false",
    "aria-busy": busy,
    className: "shrink-0",
    title: meaning + " · " + scope,
    onClick: event => event.stopPropagation(),
    onPointerDown: event => event.stopPropagation(),
    children: __JSX__.jsxs("button", {
      type: "button",
      role: "switch",
      "aria-checked": enabled,
      "aria-label": "Fast " + stateLabel + " · " + scope,
      disabled: disabled || !client || !ready || busy,
      onClick: toggle,
      className: "flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2 text-[11px] outline-none transition-colors duration-[var(--dur-2)] hover:bg-[var(--surface-3)] focus-visible:ring-1 focus-visible:ring-[var(--focus-ring)] disabled:cursor-not-allowed disabled:text-fg-5",
      style: { color: enabled ? "var(--brand-cta, #7c5ce7)" : "var(--th-fg-4, #787884)" },
      children: [
        __JSX__.jsx("svg", {
          width: 11, height: 11, viewBox: "0 0 24 24", fill: "none",
          stroke: "currentColor", strokeWidth: 1.8, strokeLinecap: "round", strokeLinejoin: "round",
          "aria-hidden": true,
          children: __JSX__.jsx("path", { d: "m13 2-9 12h7l-1 8 10-12h-7l1-8Z" }),
        }),
        __JSX__.jsx("span", { children: "Fast" }),
        __JSX__.jsx("span", {
          "aria-hidden": true,
          style: {
            display: "inline-flex", alignItems: "center", flexShrink: 0,
            width: 25, height: 14, padding: 2, borderRadius: 7,
            background: enabled ? "var(--brand-cta, #7c5ce7)" : "var(--th-fg-5, #aaaab2)",
          },
          children: __JSX__.jsx("span", {
            style: {
              display: "block", width: 10, height: 10, borderRadius: "50%",
              background: "#fff", transform: enabled ? "translateX(11px)" : "translateX(0)",
            },
          }),
        }),
        __JSX__.jsx("span", {
          "aria-hidden": true,
          style: { fontSize: 9, letterSpacing: ".02em", minWidth: 17, textAlign: "left" },
          children: stateLabel,
        }),
      ],
    }),
  });
}
/* mirasim-claude-fast-toggle:end */
