/* mirasim-ultracode-toggle:v1 */
const MirasimUltracodeSavesV1 = new WeakMap();

function MirasimUltracodeSaveStateV1(client) {
  if (!client || (typeof client !== "object" && typeof client !== "function")) return null;
  let state = MirasimUltracodeSavesV1.get(client);
  if (!state) {
    state = { pending: null, listeners: new Set() };
    MirasimUltracodeSavesV1.set(client, state);
  }
  return state;
}

function MirasimUltracodeNotifyV1(state, pending) {
  state.pending = pending;
  for (const listener of state.listeners) listener(pending);
}

function MirasimUltracodeToggleV1({ agent, disabled = false }) {
  const host = __CONTEXT__();
  const client = host.session?.client;
  const toast = __STORE__(state => state.toast);
  const catalog = __STORE__(state => state.catalogs[agent]);
  const locale = __STORE__(state => state.locale);
  const chinese = !locale || String(locale).toLowerCase().startsWith("zh");
  const ready = typeof catalog?.ultracodeEnabled === "boolean";
  const current = catalog?.ultracodeEnabled === true;
  const saveState = MirasimUltracodeSaveStateV1(client);
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
    ? "默认使用 Workflow，保持所选推理强度"
    : "Use Workflow by default while keeping the selected reasoning effort";
  const stateLabel = enabled ? "ON" : "OFF";

  const toggle = async () => {
    if (agent !== "claude" || disabled || !client || !ready ||
        !saveState || saveState.pending !== null) return;
    const next = !current;
    MirasimUltracodeNotifyV1(saveState, next);
    try {
      const reply = await __REQUEST__(client,
        { type: "setAgentDefaults", agent: "claude", ultracodeEnabled: next },
        "agentDefaults", { match: frame => frame.agent === "claude" });
      const confirmed = typeof reply?.ultracodeEnabled === "boolean" ? reply.ultracodeEnabled : next;
      __STORE__.setState(state => ({
        catalogs: {
          ...state.catalogs,
          claude: { ...state.catalogs.claude, ultracodeEnabled: confirmed },
        },
      }));
      try { client.post({ type: "getCatalog", agent: "claude" }); }
      catch (_) {
        toast?.(chinese ? "Ultracode 已保存；暂时无法刷新状态。" : "Ultracode saved; its status could not be refreshed.", false);
      }
    } catch (error) {
      toast?.((chinese ? "Ultracode 保存失败：" : "Could not save Ultracode: ") +
        (error instanceof Error ? error.message : String(error)), false);
      try { client.post({ type: "getCatalog", agent: "claude" }); } catch (_) {}
    } finally {
      MirasimUltracodeNotifyV1(saveState, null);
    }
  };

  if (agent !== "claude") return null;
  return __JSX__.jsx("div", {
    "data-mirasim-ultracode-toggle": "v1",
    "data-ultracode-enabled": enabled ? "true" : "false",
    "aria-busy": busy,
    className: "shrink-0",
    title: meaning + " · " + scope,
    onClick: event => event.stopPropagation(),
    onPointerDown: event => event.stopPropagation(),
    children: __JSX__.jsxs("button", {
      type: "button",
      role: "switch",
      "aria-checked": enabled,
      "aria-label": "Ultracode " + stateLabel + " · " + scope,
      disabled: disabled || !client || !ready || busy,
      onClick: toggle,
      className: "flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2 text-[11px] outline-none transition-colors duration-[var(--dur-2)] hover:bg-[var(--surface-3)] focus-visible:ring-1 focus-visible:ring-[var(--focus-ring)] disabled:cursor-not-allowed disabled:text-fg-5",
      style: { color: enabled ? "var(--brand-cta, #7c5ce7)" : "var(--th-fg-4, #787884)" },
      children: [
        __JSX__.jsx("span", { children: "Ultracode" }),
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
/* mirasim-ultracode-toggle:end */
