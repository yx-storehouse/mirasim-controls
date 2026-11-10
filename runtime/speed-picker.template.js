/* mirasim-speed-picker:v1 */
const MirasimSpeedSaveV1 = { pending: null, listeners: new Set() };

function MirasimSpeedNotifyV1(pending) {
  MirasimSpeedSaveV1.pending = pending;
  for (const listener of MirasimSpeedSaveV1.listeners) listener(pending);
}

function MirasimSpeedPickerV1({ agent, disabled = false }) {
  const host = __CONTEXT__();
  const client = host.session?.client;
  const toast = __STORE__(state => state.toast);
  const catalog = __STORE__(state => state.catalogs[agent]);
  const locale = __STORE__(state => state.locale);
  const chinese = !locale || String(locale).toLowerCase().startsWith("zh");
  const current = catalog?.serviceTier || "default";
  const ready = Array.isArray(catalog?.serviceTiers);
  const [pending, setPending] = __REACT__.useState(MirasimSpeedSaveV1.pending);

  __REACT__.useEffect(() => {
    MirasimSpeedSaveV1.listeners.add(setPending);
    setPending(MirasimSpeedSaveV1.pending);
    return () => MirasimSpeedSaveV1.listeners.delete(setPending);
  }, []);

  __REACT__.useEffect(() => {
    if (agent === "codex" && client && !ready) {
      client.post({ type: "getCatalog", agent });
    }
  }, [agent, client, ready]);

  const labels = chinese
    ? { default: "跟随配置", standard: "标准", priority: "Fast", ultrafast: "Ultrafast" }
    : { default: "Configured", standard: "Standard", priority: "Fast", ultrafast: "Ultrafast" };
  const descriptions = chinese
    ? { default: "跟随 Codex 原生配置", standard: "标准速度", priority: "优先速度", ultrafast: "最高速度 · 需模型与端点支持" }
    : { default: "Follow native Codex settings", standard: "Standard speed", priority: "Priority speed", ultrafast: "Fastest tier · Model and endpoint support required" };
  const scope = chinese ? "Codex 全局 · 下轮生效" : "Codex default · Next turn";
  const advertised = new Set((catalog?.serviceTiers || []).map(tier => tier.id));
  const options = ["default", "standard", "priority", "ultrafast"]
    .filter(value => value === "default" || advertised.has(value))
    .map(value => ({
      value,
      label: labels[value],
      description: descriptions[value],
    }));
  const value = pending ?? current;
  if (!options.some(option => option.value === value)) {
    options.push({
      value,
      label: labels[value] || value,
      description: chinese ? "当前配置；此档位未列在可选项中" : "Current setting; not advertised as available",
      disabled: true,
    });
  }

  const selectTier = async next => {
    if (agent !== "codex" || disabled || !client || !ready ||
        MirasimSpeedSaveV1.pending !== null || next === current ||
        !options.some(option => option.value === next && !option.disabled)) return;

    MirasimSpeedNotifyV1(next);
    try {
      await __REQUEST__(client,
        { type: "setAgentDefaults", agent: "codex", serviceTier: next },
        "agentDefaults",
        { match: frame => frame.agent === "codex" });
      __STORE__.setState(state => ({
        catalogs: {
          ...state.catalogs,
          codex: { ...state.catalogs.codex, serviceTier: next },
        },
      }));
      // The save has been acknowledged. Refresh capability data without
      // misreporting an acknowledged save as a failed change.
      try {
        client.post({ type: "getCatalog", agent: "codex" });
      } catch (error) {
        toast?.(chinese
          ? "速度档位已保存；暂时无法刷新可选档位。"
          : "Speed saved; available tiers could not be refreshed.", false);
      }
    } catch (error) {
      toast?.((chinese ? "速度档位保存失败：" : "Could not save speed: ") +
        (error instanceof Error ? error.message : String(error)), false);
      // An acknowledgement can time out after a server has applied a save.
      // Keep the prior confirmed value, and ask the server to reconcile it.
      try { client.post({ type: "getCatalog", agent: "codex" }); } catch (_) {}
    } finally {
      MirasimSpeedNotifyV1(null);
    }
  };

  if (agent !== "codex") return null;
  const busy = pending !== null;
  return __JSX__.jsx("div", {
    "data-mirasim-speed-picker": "v1",
    "data-service-tier": value,
    "aria-busy": busy,
    className: "shrink-0",
    title: scope,
    onClick: event => event.stopPropagation(),
    onPointerDown: event => event.stopPropagation(),
    children: __JSX__.jsx(__SELECT__, {
      value,
      options,
      onChange: selectTier,
      disabled: disabled || !client || !ready || busy,
      collapseWhenSingle: false,
      variant: "ghost",
      size: "sm",
      align: "end",
      menuMinWidth: 240,
      ariaLabel: (chinese ? "速度档位" : "Speed tier") + " · " + scope,
      leading: __JSX__.jsxs("span", {
        className: "flex items-center gap-1",
        children: [
          __JSX__.jsx("svg", {
            width: 12, height: 12, viewBox: "0 0 24 24", fill: "none",
            stroke: "currentColor", strokeWidth: 1.8, strokeLinecap: "round", strokeLinejoin: "round",
            "aria-hidden": true,
            children: __JSX__.jsx("path", { d: "m13 2-9 12h7l-1 8 10-12h-7l1-8Z" }),
          }),
          (chinese ? "速度" : "Speed") + " ·",
        ],
      }),
    }),
  });
}
/* mirasim-speed-picker:end */
