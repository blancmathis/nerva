import { CodexDesktopAdapterError } from "./errors.js";
import { isAllowlistedNativeAction, isAllowlistedNativeJoystickAction } from "./native-allowlist.js";
import { extractThreadId } from "./snapshot.js";
import {
  NATIVE_CONTROL_IDENTIFIERS,
  type NativeComposerImageAttachment,
  type NativeComposerImageBatch,
  type NativeDispatch,
} from "./types.js";

/*
 * The native-state technique is independently implemented from observable Codex
 * renderer shapes. Dynamic hashed-module discovery and React-store traversal are
 * informed by codex-stream-deck (MIT, Copyright 2026 Dazer). Keep its attribution
 * in THIRD_PARTY_NOTICES.md when distributing this package.
 *
 * This expression is bridge-authored and constant. No HTTP, WebSocket, or UI input
 * is ever inserted into it.
 */
export const FIXED_NATIVE_SNAPSHOT_EXPRESSION = String.raw`(async () => {
  const ACTION_SLOTS = ['ACT06', 'ACT07', 'ACT08', 'ACT09', 'ACT10_ACT11', 'ACT12'];
  const DIRECTIONS = ['up', 'right', 'down', 'left'];
  const safeText = (value) => typeof value === 'string' && value.length <= 128 ? value : null;
  const indexOfSlot = (slot) => {
    if (Number.isInteger(slot?.index)) return slot.index;
    if (Number.isInteger(slot?.id)) return slot.id;
    const match = String(slot?.key ?? slot?.slotKey ?? '').match(/^AG0([0-5])$/);
    return match ? Number(match[1]) : -1;
  };
  const isLiveSlots = (value) => {
    if (!Array.isArray(value) || value.length !== 6) return false;
    const indexes = value.map(indexOfSlot);
    return new Set(indexes).size === 6 && indexes.every((index) => index >= 0 && index <= 5) && value.every((slot) => typeof slot?.status === 'string');
  };
  const toEpoch = (value) => {
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value < 100000000000 ? Math.trunc(value * 1000) : Math.trunc(value);
    if (typeof value === 'string' && value.length <= 64) {
      const parsed = Date.parse(value);
      if (Number.isFinite(parsed) && parsed > 0) return parsed;
    }
    return null;
  };
  const findSlots = (value, depth = 0, seen = new Set()) => {
    if (isLiveSlots(value)) return value;
    if (!value || typeof value !== 'object' || depth > 3 || seen.has(value)) return null;
    seen.add(value);
    for (const key of ['slots', 'agents', 'value', 'current', 'data', 'state', 'snapshot']) {
      try {
        const found = findSlots(value[key], depth + 1, seen);
        if (found) return found;
      } catch {}
    }
    return null;
  };

  const assetUrls = [...new Set([
    ...[...document.querySelectorAll('link[href], script[src]')].map((node) => node.href || node.src),
    ...performance.getEntriesByType('resource').map((entry) => entry.name)
  ])].filter((url) => typeof url === 'string' && url.includes('/assets/') && /\.js(?:\?|$)/.test(url)).slice(0, 300);

  const moduleValues = [];
  for (const url of assetUrls) {
    try {
      const namespace = await import(url);
      moduleValues.push(...Object.values(namespace));
    } catch {}
  }

  // Also inspect already-loaded webpack module caches without accepting module
  // names or source from callers. Vite/electron split chunks use the imports above.
  for (const globalName of Object.getOwnPropertyNames(globalThis).filter((name) => name.startsWith('webpackChunk'))) {
    try {
      const chunk = globalThis[globalName];
      if (!Array.isArray(chunk) || typeof chunk.push !== 'function') continue;
      let runtime = null;
      chunk.push([['codex-pad-native-state'], {}, (candidate) => { runtime = candidate; }]);
      if (runtime?.c) {
        for (const loaded of Object.values(runtime.c)) {
          if (loaded?.exports) moduleValues.push(loaded.exports, ...Object.values(loaded.exports));
        }
      }
    } catch {}
  }

  const root = document.getElementById('root');
  const reactProperty = root && Object.getOwnPropertyNames(root).find((name) => name.startsWith('__reactContainer$') || name.startsWith('__reactFiber$'));
  if (!root || !reactProperty) throw new Error('Codex React root is unavailable.');

  const resolvers = moduleValues.filter((value) => value && typeof value === 'object' && typeof value.resolve === 'function' && typeof value.createSubscriberAtom === 'function');
  const queue = [root[reactProperty]];
  const visited = new Set();
  let located = null;
  while (queue.length && visited.size < 40000 && !located) {
    const fiber = queue.pop();
    if (!fiber || visited.has(fiber)) continue;
    visited.add(fiber);

    for (const value of [fiber.memoizedProps, fiber.pendingProps, fiber.memoizedState]) {
      const direct = findSlots(value);
      if (direct) {
        located = { slots: direct, node: null, chain: null };
        break;
      }
    }
    if (located) break;

    const maps = [];
    if (fiber.memoizedProps?.value instanceof Map) maps.push(fiber.memoizedProps.value);
    let dependency = fiber.dependencies?.firstContext;
    while (dependency) {
      if (dependency.memoizedValue instanceof Map) maps.push(dependency.memoizedValue);
      dependency = dependency.next;
    }
    for (const chain of maps) {
      for (const node of chain.values()) {
        if (!node?.store || typeof node.store.get !== 'function') continue;
        for (const resolver of resolvers) {
          try {
            const atom = resolver.resolve(node, chain);
            const slots = node.store.get(atom);
            if (isLiveSlots(slots)) {
              located = { slots, node, chain };
              break;
            }
          } catch {}
        }
        if (located) break;
      }
      if (located) break;
    }
    queue.push(fiber.child, fiber.sibling);
  }
  if (!located) throw new Error('Six live Codex Micro slots were not found.');

  const definitions = moduleValues.find((value) => value && typeof value === 'object' && value.layout?.key === 'codex-micro-layout' && value.agentSource?.key === 'codex-micro-agent-source');
  const definitionValues = moduleValues.filter((value) => value && typeof value === 'object' && typeof value.key === 'string');
  const reasoningDefinition = definitions?.reasoningEffort ?? definitions?.reasoning ?? definitionValues.find((value) => /reasoning.*effort|effort.*reasoning/i.test(value.key));
  let layoutValue = null;
  let agentSource = null;
  let reasoningEffort = null;

  const acceptSetting = (definition, candidate) => {
    if (!definition) return;
    if (definition === definitions?.layout && candidate?.version === 1 && candidate.slots && candidate.analogStick) layoutValue = candidate;
    if (definition === definitions?.agentSource && ['pinned', 'recent', 'priority', 'custom'].includes(candidate)) agentSource = candidate;
    if (definition === reasoningDefinition && ['minimal', 'low', 'medium', 'high', 'xhigh', 'ultra', 'max'].includes(candidate)) reasoningEffort = candidate;
  };

  const directReaders = moduleValues.filter((value) => typeof value === 'function' && value.length === 1 && Function.prototype.toString.call(value).includes('get-setting'));
  for (const reader of directReaders) {
    for (const definition of [definitions?.layout, definitions?.agentSource, reasoningDefinition]) {
      try { acceptSetting(definition, await reader(definition)); } catch {}
    }
    if (layoutValue && agentSource && reasoningEffort) break;
  }

  if (located.node?.store && (!layoutValue || !agentSource || !reasoningEffort)) {
    const getStoreValue = located.node.store.get.bind(located.node.store);
    const storeReaders = moduleValues.filter((value) => {
      if (typeof value !== 'function' || value.length !== 2) return false;
      const source = Function.prototype.toString.call(value);
      return source.includes('.key') && source.includes('.default');
    });
    for (const reader of storeReaders) {
      for (const definition of [definitions?.layout, definitions?.agentSource, reasoningDefinition]) {
        try { acceptSetting(definition, await reader(getStoreValue, definition)); } catch {}
      }
      if (layoutValue && agentSource && reasoningEffort) break;
    }
  }

  const actionAssignment = (value) => {
    if (!value || typeof value !== 'object') return null;
    const keycapId = safeText(value.keycapId ?? value.keycap?.id ?? value.id);
    if (!keycapId) return null;
    return { keycapId, commandId: safeText(value.commandId ?? value.command?.id ?? null) };
  };
  const joystickAssignment = (value) => {
    if (!value || typeof value !== 'object' || !Object.prototype.hasOwnProperty.call(value, 'type') || !Object.prototype.hasOwnProperty.call(value, 'commandId') || value.type !== 'command') return null;
    const commandId = safeText(value.commandId);
    return commandId ? { type: 'command', commandId } : null;
  };
  const actionLayout = layoutValue?.slots && ACTION_SLOTS.every((slot) => actionAssignment(layoutValue.slots[slot]))
    ? ACTION_SLOTS.map((slot) => ({ slot, ...actionAssignment(layoutValue.slots[slot]) }))
    : null;
  const joystickLayout = layoutValue?.analogStick && DIRECTIONS.every((direction) => joystickAssignment(layoutValue.analogStick[direction]))
    ? Object.fromEntries(DIRECTIONS.map((direction) => [direction, { direction, ...joystickAssignment(layoutValue.analogStick[direction]) }]))
    : null;

  const bus = moduleValues.find((value) => value && typeof value === 'object' && value.handlers instanceof Map && (typeof value.dispatchHostMessage === 'function' || typeof value.dispatchMessage === 'function'));
  const hidHandler = Boolean(bus && (bus.handlers.get('codex-micro-hid-event')?.size ?? 0) > 0);
  const joystickHandler = Boolean(bus && (bus.handlers.get('codex-micro-joystick-event')?.size ?? 0) > 0);
  const reasoningAdjustable = Boolean(reasoningEffort && hidHandler);

  const addContextControls = [...document.querySelectorAll('button[data-composer-navigation-target="add-context"]')];
  let composerPasteTarget = addContextControls.length === 1 ? addContextControls[0].parentElement : null;
  while (composerPasteTarget) {
    const propsKey = Object.getOwnPropertyNames(composerPasteTarget).find((name) => name.startsWith('__reactProps$'));
    if (propsKey && typeof composerPasteTarget[propsKey]?.onPaste === 'function') break;
    composerPasteTarget = composerPasteTarget.parentElement;
  }
  const composerAttachmentHandler = Boolean(
    composerPasteTarget
    && typeof File === 'function'
    && typeof DataTransfer === 'function'
    && typeof ClipboardEvent === 'function'
  );

  const html = document.documentElement;
  const body = document.body;
  const themeWords = [html.dataset.theme, html.dataset.colorScheme, html.className, body?.dataset?.theme, body?.className, getComputedStyle(html).colorScheme].filter(Boolean).join(' ').toLowerCase();
  const explicitDark = /(^|[\s_-])dark($|[\s_-])/.test(themeWords);
  const explicitLight = /(^|[\s_-])light($|[\s_-])/.test(themeWords);
  let theme = null;
  if (explicitDark) theme = 'dark';
  else if (explicitLight) theme = 'light';
  else {
    const surface = [body, root, html].find((element) => element && getComputedStyle(element).backgroundColor !== 'rgba(0, 0, 0, 0)');
    const channels = surface && getComputedStyle(surface).backgroundColor.match(/rgba?\(([^)]+)\)/)?.[1]?.split(',').map(Number);
    if (channels?.length >= 3) theme = (0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2]) / 255 < 0.42 ? 'dark' : 'light';
  }

  const rawSlots = located.slots.map((slot) => {
    const index = indexOfSlot(slot);
    return {
      index,
      key: 'AG0' + index,
      threadKey: slot.threadKey ?? slot.threadId ?? null,
      title: typeof slot.title === 'string' ? slot.title : null,
      status: typeof slot.status === 'string' ? slot.status : 'unknown',
      selected: slot.selected === true,
      activityAt: toEpoch(slot.activityAt) ?? toEpoch(slot.updatedAt) ?? toEpoch(slot.lastActivityAt) ?? toEpoch(slot.thread?.updatedAt) ?? toEpoch(slot.task?.updatedAt)
    };
  });
  const selectedThreadKey = rawSlots.find((slot) => slot.selected)?.threadKey ?? null;
  const sidebarThreadKey = document.querySelector('[data-app-action-sidebar-thread-id][aria-current="page"]')?.getAttribute('data-app-action-sidebar-thread-id') ?? null;
  const composerThreadKey = document.querySelector('[data-above-composer-conversation-id]')?.getAttribute('data-above-composer-conversation-id') ?? null;
  const isClientNewThreadKey = (value) => typeof value === 'string'
    && /^local:client-new-thread:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
  const canonicalThreadSignal = (value) => typeof value === 'string'
    ? value.match(/(?:^|[^0-9a-f])([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})(?=$|[^0-9a-f])/i)?.[1]?.toLowerCase() ?? null
    : null;
  const selectedCanonicalThread = isClientNewThreadKey(selectedThreadKey) ? null : canonicalThreadSignal(selectedThreadKey);
  const sidebarCanonicalThread = isClientNewThreadKey(sidebarThreadKey) ? null : canonicalThreadSignal(sidebarThreadKey);
  const composerCanonicalThread = canonicalThreadSignal(composerThreadKey);
  // During creation/migration, Desktop can keep the selected Micro slot and
  // current sidebar row on the same client-local key while the live composer
  // already exposes the durable conversation UUID. Reconcile only this exact
  // three-signal tuple; titles and unrelated local keys are never authority.
  const bridgedClientThread = isClientNewThreadKey(selectedThreadKey)
    && selectedThreadKey === sidebarThreadKey
    && composerCanonicalThread !== null
    ? composerCanonicalThread
    : null;
  const slots = rawSlots.map((slot) => slot.selected && bridgedClientThread !== null
    ? { ...slot, threadKey: bridgedClientThread }
    : slot);
  // The current sidebar row is navigation authority even when the open task is
  // outside Codex Micro's six slots. The composer marker is a secondary signal:
  // current Desktop builds can leave it on the previous task while the sidebar
  // and Micro store have already moved. Without a canonical sidebar signal, a
  // disagreeing composer/slot pair remains ambiguous and fails closed.
  const activeThreadKey = bridgedClientThread ?? sidebarCanonicalThread
    ?? (composerCanonicalThread === null
      ? selectedCanonicalThread
      : selectedCanonicalThread === null || composerCanonicalThread === selectedCanonicalThread
        ? composerCanonicalThread
        : null);
  const activeThreadConfirmed = activeThreadKey !== null;

  return {
    slots,
    activeThreadKey,
    activeThreadObserved: activeThreadConfirmed,
    agentSource,
    actionLayout,
    joystickLayout,
    reasoning: reasoningEffort ? { effort: reasoningEffort, adjustable: reasoningAdjustable } : null,
    theme,
    handlers: { hid: hidHandler, joystick: joystickHandler, composerAttachment: composerAttachmentHandler }
  };
})()`;

const DEVICE_READY_MESSAGE = {
  type: "codex-micro-device-state-changed",
  state: {
    status: "connected",
    error: null,
    battery: { percentage: 100, isCharging: true }
  }
} as const;

/**
 * Builds only one of two typed native event shapes. JSON encoding makes validated
 * data inert; this function cannot accept JavaScript source.
 */
export function buildFixedDispatchExpression(event: NativeDispatch): string {
  validateDispatch(event);
  const expectedThreadId = event.kind === "agent" ? event.threadKey : event.expectedThreadId;
  const requiredHandler = event.kind === "joystick" ? "codex-micro-joystick-event" : "codex-micro-hid-event";
  const messages = event.kind === "agent"
    ? [1, 0].map((act) => ({
        type: "codex-micro-hid-event",
        event: { key: event.key, act, slot: event.index, threadKey: event.threadKey }
      }))
    : event.kind === "action"
      ? (event.gesture === "begin" ? [1] : event.gesture === "end" ? [0] : [1, 0]).map((act) => ({
          type: "codex-micro-hid-event",
          event: { key: event.key, act, slot: null, threadKey: null }
        }))
      : event.kind === "reasoning"
        ? [{
            type: "codex-micro-hid-event",
            event: { key: event.key, act: 2, slot: null, threadKey: null }
          }]
        : [1, 0].map((distance) => ({
            type: "codex-micro-joystick-event",
            event: { angle: ({ up: 0.75, right: 0, down: 0.25, left: 0.5 } as const)[event.direction], distance }
          }));

  return String.raw`(async () => {
    let codexPadDispatchMayHaveFired = false;
    const codexPadPreFireDeadline = Date.now() + 5000;
	    try {
	    const expectedThreadId = ${JSON.stringify(expectedThreadId)};
	    const canonicalThreadId = (value) => typeof value === 'string'
	      ? value.match(/(?:^|[^0-9a-f])([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})(?=$|[^0-9a-f])/i)?.[1]?.toLowerCase() ?? null
	      : null;
	    const isClientNewThreadKey = (value) => typeof value === 'string'
	      && /^local:client-new-thread:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
	    ${event.kind === "agent" ? "" : String.raw`const assertExpectedThread = () => {
      const sidebarValue = document.querySelector('[data-app-action-sidebar-thread-id][aria-current="page"]')?.getAttribute('data-app-action-sidebar-thread-id') ?? null;
      const composerValue = document.querySelector('[data-above-composer-conversation-id]')?.getAttribute('data-above-composer-conversation-id') ?? null;
      if (isClientNewThreadKey(sidebarValue) && canonicalThreadId(composerValue) === expectedThreadId) return;
      const activeMatches = [sidebarValue, composerValue]
        .map((value) => canonicalThreadId(value))
        .filter((value) => value !== null);
      if (activeMatches.some((value) => value !== expectedThreadId)) throw new Error('Active Codex thread changed before native dispatch.');
    };
    assertExpectedThread();`}
    const urls = [...new Set([
      ...[...document.querySelectorAll('link[href], script[src]')].map((node) => node.href || node.src),
      ...performance.getEntriesByType('resource').map((entry) => entry.name)
    ])].filter((url) => typeof url === 'string' && url.includes('/assets/') && /\.js(?:\?|$)/.test(url)).slice(0, 300);
    let bus = null;
    const moduleValues = [];
    for (const url of urls) {
      try {
        const namespace = await import(url);
        const values = Object.values(namespace);
        moduleValues.push(...values);
        bus ??= values.find((value) => value && typeof value === 'object' && value.handlers instanceof Map && (typeof value.dispatchHostMessage === 'function' || typeof value.dispatchMessage === 'function'));
      } catch {}
    }
    for (const globalName of Object.getOwnPropertyNames(globalThis).filter((name) => name.startsWith('webpackChunk'))) {
      try {
        const chunk = globalThis[globalName];
        if (!Array.isArray(chunk) || typeof chunk.push !== 'function') continue;
        let runtime = null;
        chunk.push([['codex-pad-native-dispatch'], {}, (candidate) => { runtime = candidate; }]);
        if (!runtime?.c) continue;
        for (const loaded of Object.values(runtime.c)) {
          if (!loaded?.exports) continue;
          const values = [loaded.exports, ...Object.values(loaded.exports)];
          moduleValues.push(...values);
          bus ??= values.find((value) => value && typeof value === 'object' && value.handlers instanceof Map && (typeof value.dispatchHostMessage === 'function' || typeof value.dispatchMessage === 'function'));
        }
      } catch {}
    }
    if (!bus) throw new Error('Codex native event bus is unavailable.');
    ${String.raw`
    const slotIndex = (slot) => {
      if (Number.isInteger(slot?.index)) return slot.index;
      if (Number.isInteger(slot?.id)) return slot.id;
      const match = String(slot?.key ?? slot?.slotKey ?? '').match(/^AG0([0-5])$/);
      return match ? Number(match[1]) : -1;
    };
    const isLiveSlots = (value) => Array.isArray(value)
      && value.length === 6
      && new Set(value.map(slotIndex)).size === 6
      && value.every((slot) => slotIndex(slot) >= 0 && slotIndex(slot) <= 5 && typeof slot?.status === 'string');
    const findLiveSlots = (value, depth = 0, seen = new Set()) => {
      if (isLiveSlots(value)) return value;
      if (!value || typeof value !== 'object' || depth > 3 || seen.has(value)) return null;
      seen.add(value);
      for (const key of ['slots', 'agents', 'value', 'current', 'data', 'state', 'snapshot']) {
        try {
          const found = findLiveSlots(value[key], depth + 1, seen);
          if (found) return found;
        } catch {}
      }
      return null;
    };
    const slotResolvers = moduleValues.filter((value) => value && typeof value === 'object' && typeof value.resolve === 'function' && typeof value.createSubscriberAtom === 'function');
    const readLiveSlots = () => {
      const liveRoot = document.getElementById('root');
      const liveReactProperty = liveRoot && Object.getOwnPropertyNames(liveRoot).find((name) => name.startsWith('__reactContainer$') || name.startsWith('__reactFiber$'));
      if (!liveRoot || !liveReactProperty) return null;
      const queue = [liveRoot[liveReactProperty]];
      const visited = new Set();
      while (queue.length && visited.size < 40000) {
        const fiber = queue.pop();
        if (!fiber || visited.has(fiber)) continue;
        visited.add(fiber);
        for (const value of [fiber.memoizedProps, fiber.pendingProps, fiber.memoizedState]) {
          const direct = findLiveSlots(value);
          if (direct) return direct;
        }
        const maps = [];
        if (fiber.memoizedProps?.value instanceof Map) maps.push(fiber.memoizedProps.value);
        let dependency = fiber.dependencies?.firstContext;
        while (dependency) {
          if (dependency.memoizedValue instanceof Map) maps.push(dependency.memoizedValue);
          dependency = dependency.next;
        }
        for (const chain of maps) {
          for (const node of chain.values()) {
            if (!node?.store || typeof node.store.get !== 'function') continue;
            for (const resolver of slotResolvers) {
              try {
                const atom = resolver.resolve(node, chain);
                const slots = node.store.get(atom);
                if (isLiveSlots(slots)) return slots;
              } catch {}
            }
          }
        }
        queue.push(fiber.child, fiber.sibling);
      }
      return null;
    };
    const exactSlotThreadId = (slot) => {
      const value = slot?.threadKey ?? slot?.threadId ?? null;
      return isClientNewThreadKey(value) ? null : canonicalThreadId(value);
    };
    const slotMatchesExpectedThread = (slot) => {
      if (exactSlotThreadId(slot) === expectedThreadId) return true;
      const slotValue = slot?.threadKey ?? slot?.threadId ?? null;
      const sidebarValue = document.querySelector('[data-app-action-sidebar-thread-id][aria-current="page"]')?.getAttribute('data-app-action-sidebar-thread-id') ?? null;
      const composerValue = document.querySelector('[data-above-composer-conversation-id]')?.getAttribute('data-above-composer-conversation-id') ?? null;
      return slot?.selected === true
        && isClientNewThreadKey(slotValue)
        && slotValue === sidebarValue
        && canonicalThreadId(composerValue) === expectedThreadId;
    };
    const assertExpectedSlotContext = () => {
      const slots = readLiveSlots();
      if (!slots) throw new Error('Live Codex agent slots are unavailable at native dispatch.');
      ${event.kind === "agent"
        ? `const slot = slots.find((candidate) => slotIndex(candidate) === ${event.index});
	      if (!slot || !slotMatchesExpectedThread(slot)) throw new Error('Codex native agent slot changed before selection dispatch.');`
        : event.kind === "action"
          ? `const slot = slots.find((candidate) => slotIndex(candidate) === ${event.expectedAgentSlot});
	      if (!slot || slot.selected !== true || !slotMatchesExpectedThread(slot)) throw new Error('Codex native agent slot changed before action dispatch.');
      const status = String(slot.status).toLowerCase().replace(/[^a-z0-9]/g, '');
      if (status.includes('approval')) throw new Error('Generic native controls are locked while an exact approval is pending.');`
	          : `const slot = slots.find((candidate) => candidate?.selected === true && slotMatchesExpectedThread(candidate));
      if (!slot) throw new Error('Codex selected native agent changed before native control dispatch.');
      const status = String(slot.status).toLowerCase().replace(/[^a-z0-9]/g, '');
      if (status.includes('approval')) throw new Error('Generic native controls are locked while an exact approval is pending.');`}
    };`}
    ${event.kind === "action" || event.kind === "joystick" ? String.raw`
    const expectedKeycapId = ${event.kind === "action" ? JSON.stringify(event.expectedKeycapId) : "null"};
    const expectedAssignmentType = ${event.kind === "joystick" ? JSON.stringify(event.expectedAssignment.type) : "null"};
    const expectedNativeCommandId = ${JSON.stringify(event.kind === "action" ? event.expectedNativeCommandId : event.expectedAssignment.commandId)};
    const isLayout = (value) => value && typeof value === 'object' && value.version === 1 && value.slots && value.analogStick;
    const definitions = moduleValues.find((value) => value && typeof value === 'object' && value.layout?.key === 'codex-micro-layout');
    const layoutDefinition = definitions?.layout ?? moduleValues.find((value) => value && typeof value === 'object' && value.key === 'codex-micro-layout');
    if (!layoutDefinition) throw new Error('Codex native action layout definition is unavailable.');
    const directReaders = moduleValues.filter((value) => typeof value === 'function' && value.length === 1 && Function.prototype.toString.call(value).includes('get-setting'));
    const storeReaders = moduleValues.filter((value) => {
      if (typeof value !== 'function' || value.length !== 2) return false;
      const source = Function.prototype.toString.call(value);
      return source.includes('.key') && source.includes('.default');
    });
    const storeGetters = [];
    const root = document.getElementById('root');
    const reactProperty = root && Object.getOwnPropertyNames(root).find((name) => name.startsWith('__reactContainer$') || name.startsWith('__reactFiber$'));
    if (root && reactProperty) {
      const queue = [root[reactProperty]];
      const visited = new Set();
      while (queue.length && visited.size < 40000 && storeGetters.length < 128) {
        const fiber = queue.pop();
        if (!fiber || visited.has(fiber)) continue;
        visited.add(fiber);
        const maps = [];
        if (fiber.memoizedProps?.value instanceof Map) maps.push(fiber.memoizedProps.value);
        let dependency = fiber.dependencies?.firstContext;
        while (dependency) {
          if (dependency.memoizedValue instanceof Map) maps.push(dependency.memoizedValue);
          dependency = dependency.next;
        }
        for (const chain of maps) {
          for (const node of chain.values()) {
            if (node?.store && typeof node.store.get === 'function') storeGetters.push(node.store.get.bind(node.store));
          }
        }
        queue.push(fiber.child, fiber.sibling);
      }
    }
    const readLayout = async () => {
      for (const reader of directReaders) {
        try {
          const value = await reader(layoutDefinition);
          if (isLayout(value)) return value;
        } catch {}
      }
      for (const getStoreValue of storeGetters) {
        for (const reader of storeReaders) {
          try {
            const value = await reader(getStoreValue, layoutDefinition);
            if (isLayout(value)) return value;
          } catch {}
        }
      }
      // Module exports may contain static defaults or stale cached objects. Only
      // a live setting/store read is authoritative at the write boundary.
      return null;
    };
    const readActionAssignment = (value) => {
      if (!value || typeof value !== 'object') return null;
      const keycapId = value.keycapId ?? value.keycap?.id ?? value.id;
      const commandValue = value.commandId ?? value.command?.id ?? null;
      if (typeof keycapId !== 'string' || keycapId.length < 1 || keycapId.length > 128 || !/^[A-Za-z0-9][A-Za-z0-9_.:+/-]*$/.test(keycapId)) return null;
      if (commandValue !== null && (typeof commandValue !== 'string' || commandValue.length < 1 || commandValue.length > 128 || !/^[A-Za-z0-9][A-Za-z0-9_.:+/-]*$/.test(commandValue))) return null;
      return { keycapId, nativeCommandId: commandValue };
    };
    const readJoystickAssignment = (value) => {
      if (!value || typeof value !== 'object' || !Object.prototype.hasOwnProperty.call(value, 'type') || !Object.prototype.hasOwnProperty.call(value, 'commandId') || value.type !== 'command') return null;
      const commandValue = value.commandId;
      if (typeof commandValue !== 'string' || commandValue.length < 1 || commandValue.length > 128 || !/^[A-Za-z0-9][A-Za-z0-9_.:+/-]*$/.test(commandValue)) return null;
      return { type: 'command', nativeCommandId: commandValue };
    };
    const assertExpectedAssignment = async () => {
      const layout = await readLayout();
      const value = ${event.kind === "action"
        ? `layout?.slots?.[${JSON.stringify(event.slot)}]`
        : `layout?.analogStick?.[${JSON.stringify(event.direction)}]`};
      const assignment = ${event.kind === "action" ? "readActionAssignment(value)" : "readJoystickAssignment(value)"};
      const matches = ${event.kind === "action"
        ? "assignment?.keycapId === expectedKeycapId && assignment?.nativeCommandId === expectedNativeCommandId"
        : "assignment?.type === expectedAssignmentType && assignment?.nativeCommandId === expectedNativeCommandId"};
      if (!matches) {
        throw new Error(${JSON.stringify(`Codex native ${event.kind} assignment changed before dispatch.`)});
      }
    };` : ""}
    const dispatch = bus.dispatchHostMessage ?? bus.dispatchMessage;
    if ((bus.handlers.get(${JSON.stringify(requiredHandler)})?.size ?? 0) === 0) dispatch.call(bus, ${JSON.stringify(DEVICE_READY_MESSAGE)});
    const deadline = Date.now() + 1200;
    while ((bus.handlers.get(${JSON.stringify(requiredHandler)})?.size ?? 0) === 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
    if ((bus.handlers.get(${JSON.stringify(requiredHandler)})?.size ?? 0) === 0) throw new Error('Codex native Micro handler is inactive.');
    ${event.kind === "action" || event.kind === "joystick" ? "await assertExpectedAssignment();" : ""}
    if (Date.now() > codexPadPreFireDeadline) throw new Error('Codex native dispatch expired before any event fired.');
    assertExpectedSlotContext();
    ${event.kind === "agent" ? "" : "assertExpectedThread();"}
    // This press/release pair is one indivisible virtual gesture. A target-changing
    // press may synchronously update React selection, so rechecking the old target
    // between the pair could strand the virtual input in its pressed state.
    for (const message of ${JSON.stringify(messages)}) {
      codexPadDispatchMayHaveFired = true;
      dispatch.call(bus, message);
    }
    return true;
    } catch (error) {
      if (codexPadDispatchMayHaveFired) {
        const message = error instanceof Error ? error.message : 'Native dispatch failed after it may have fired.';
        throw new Error('CODEX_PAD_DELIVERY_UNKNOWN: ' + message);
      }
      throw error;
    }
  })()`;
}

const MAX_COMPOSER_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_COMPOSER_BATCH_BYTES = 24 * 1024 * 1024;

/**
 * Builds the only native composer mutation Codex Pad supports: append one
 * validated PNG File to the exact visible composer through its live paste
 * handler. The expression never invokes submit, keyboard shortcuts or an
 * app-server turn.
 */
export function buildFixedComposerAttachmentExpression(
  attachment: NativeComposerImageAttachment,
): string {
  validateComposerAttachment(attachment);
  return String.raw`(async () => {
    let codexPadAttachmentMayHaveFired = false;
    try {
      const expectedThreadId = ${JSON.stringify(attachment.expectedThreadId)};
      const fileName = ${JSON.stringify(attachment.fileName)};
      const pngBase64 = ${JSON.stringify(attachment.pngBase64)};
      const canonicalThreadId = (value) => typeof value === 'string'
        ? value.match(/(?:^|[^0-9a-f])([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})(?=$|[^0-9a-f])/i)?.[1]?.toLowerCase() ?? null
        : null;
      const assertExpectedComposer = () => {
        const sidebarValue = document.querySelector('[data-app-action-sidebar-thread-id][aria-current="page"]')?.getAttribute('data-app-action-sidebar-thread-id') ?? null;
        const composerValue = document.querySelector('[data-above-composer-conversation-id]')?.getAttribute('data-above-composer-conversation-id') ?? null;
        const isClientNewThreadKey = (value) => typeof value === 'string'
          && /^local:client-new-thread:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
        const composer = canonicalThreadId(composerValue);
        const sidebar = isClientNewThreadKey(sidebarValue) ? null : canonicalThreadId(sidebarValue);
        if (isClientNewThreadKey(sidebarValue) && composer === expectedThreadId) return;
        const current = sidebar ?? composer;
        if (current !== expectedThreadId) throw new Error('The exact Codex composer changed before image attachment.');
      };
      assertExpectedComposer();

      const controls = [...document.querySelectorAll('button[data-composer-navigation-target="add-context"]')];
      if (controls.length !== 1) throw new Error('The exact Codex composer attachment control is unavailable.');
      let pasteTarget = controls[0].parentElement;
      while (pasteTarget) {
        const propsKey = Object.getOwnPropertyNames(pasteTarget).find((name) => name.startsWith('__reactProps$'));
        if (propsKey && typeof pasteTarget[propsKey]?.onPaste === 'function') break;
        pasteTarget = pasteTarget.parentElement;
      }
      if (!pasteTarget || typeof File !== 'function' || typeof DataTransfer !== 'function' || typeof ClipboardEvent !== 'function') {
        throw new Error('The live Codex image paste handler is unavailable.');
      }

      const removeLabel = 'Remove ' + fileName;
      const attachmentCount = () => [...document.querySelectorAll('button')]
        .filter((node) => node.getAttribute('aria-label') === removeLabel).length;
      const beforeCount = attachmentCount();
      const raw = atob(pngBase64);
      const bytes = new Uint8Array(raw.length);
      for (let index = 0; index < raw.length; index += 1) bytes[index] = raw.charCodeAt(index);
      const file = new File([bytes], fileName, { type: 'image/png', lastModified: Date.now() });
      const transfer = new DataTransfer();
      transfer.items.add(file);
      const event = new ClipboardEvent('paste', {
        clipboardData: transfer,
        bubbles: true,
        cancelable: true,
      });
      codexPadAttachmentMayHaveFired = true;
      pasteTarget.dispatchEvent(event);
      if (!event.defaultPrevented) throw new Error('The live Codex composer did not accept the image paste event.');

      const deadline = Date.now() + 2500;
      while (Date.now() < deadline) {
        assertExpectedComposer();
        if (attachmentCount() > beforeCount) return true;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      throw new Error('The Codex composer did not confirm the image attachment.');
    } catch (error) {
      if (codexPadAttachmentMayHaveFired) {
        const message = error instanceof Error ? error.message : 'Native composer attachment failed after it may have fired.';
        throw new Error('CODEX_PAD_DELIVERY_UNKNOWN: ' + message);
      }
      throw error;
    }
  })()`;
}

/** One paste event containing an already validated, ordered image batch. */
export function buildFixedComposerBatchAttachmentExpression(batch: NativeComposerImageBatch): string {
  validateComposerBatch(batch);
  return String.raw`(async () => {
    let codexPadAttachmentMayHaveFired = false;
    try {
      const expectedThreadId = ${JSON.stringify(batch.expectedThreadId)};
      const images = ${JSON.stringify(batch.images)};
      const canonicalThreadId = (value) => typeof value === 'string'
        ? value.match(/(?:^|[^0-9a-f])([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})(?=$|[^0-9a-f])/i)?.[1]?.toLowerCase() ?? null
        : null;
      const assertExpectedComposer = () => {
        const sidebarValue = document.querySelector('[data-app-action-sidebar-thread-id][aria-current="page"]')?.getAttribute('data-app-action-sidebar-thread-id') ?? null;
        const composerValue = document.querySelector('[data-above-composer-conversation-id]')?.getAttribute('data-above-composer-conversation-id') ?? null;
        const current = canonicalThreadId(sidebarValue) ?? canonicalThreadId(composerValue);
        if (current !== expectedThreadId) throw new Error('The exact Codex composer changed before image attachment.');
      };
      assertExpectedComposer();
      const controls = [...document.querySelectorAll('button[data-composer-navigation-target="add-context"]')];
      if (controls.length !== 1) throw new Error('The exact Codex composer attachment control is unavailable.');
      let pasteTarget = controls[0].parentElement;
      while (pasteTarget) {
        const propsKey = Object.getOwnPropertyNames(pasteTarget).find((name) => name.startsWith('__reactProps$'));
        if (propsKey && typeof pasteTarget[propsKey]?.onPaste === 'function') break;
        pasteTarget = pasteTarget.parentElement;
      }
      if (!pasteTarget || typeof File !== 'function' || typeof DataTransfer !== 'function' || typeof ClipboardEvent !== 'function') {
        throw new Error('The live Codex image paste handler is unavailable.');
      }
      const counts = new Map(images.map((image) => {
        const label = 'Remove ' + image.fileName;
        return [label, [...document.querySelectorAll('button')].filter((node) => node.getAttribute('aria-label') === label).length];
      }));
      const transfer = new DataTransfer();
      for (const image of images) {
        const raw = atob(image.pngBase64);
        const bytes = new Uint8Array(raw.length);
        for (let index = 0; index < raw.length; index += 1) bytes[index] = raw.charCodeAt(index);
        transfer.items.add(new File([bytes], image.fileName, { type: 'image/png', lastModified: Date.now() }));
      }
      const event = new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true });
      codexPadAttachmentMayHaveFired = true;
      pasteTarget.dispatchEvent(event);
      if (!event.defaultPrevented) throw new Error('The live Codex composer did not accept the image batch.');
      const deadline = Date.now() + 4000;
      while (Date.now() < deadline) {
        assertExpectedComposer();
        const confirmed = [...counts].every(([label, before]) =>
          [...document.querySelectorAll('button')].filter((node) => node.getAttribute('aria-label') === label).length > before,
        );
        if (confirmed) return true;
        await new Promise((resolve) => setTimeout(resolve, 30));
      }
      const confirmedNames = [...counts]
        .filter(([label, before]) => [...document.querySelectorAll('button')].filter((node) => node.getAttribute('aria-label') === label).length > before)
        .map(([label]) => label.slice('Remove '.length));
      if (confirmedNames.length === 0) {
        throw new Error('CODEX_PAD_BATCH_NONE: No named image from the batch is visible in the exact composer.');
      }
      throw new Error('CODEX_PAD_BATCH_PARTIAL: ' + confirmedNames.join(', '));
    } catch (error) {
      if (codexPadAttachmentMayHaveFired) {
        const message = error instanceof Error ? error.message : 'Native composer batch failed after it may have fired.';
        if (message.startsWith('CODEX_PAD_BATCH_NONE:') || message.startsWith('CODEX_PAD_BATCH_PARTIAL:')) throw error;
        throw new Error('CODEX_PAD_DELIVERY_UNKNOWN: ' + message);
      }
      throw error;
    }
  })()`;
}

function validateComposerAttachment(attachment: NativeComposerImageAttachment): void {
  const threadId = extractThreadId(attachment.expectedThreadId);
  if (threadId === null || threadId !== attachment.expectedThreadId) {
    throw new CodexDesktopAdapterError(
      "invalid-thread-key",
      "Refusing native composer attachment without a canonical expected thread UUID.",
    );
  }
  if (attachment.fileName !== "Codex Pad Drawing.png" && !/^Nerva Board [A-Za-z0-9._ -]+\.png$/u.test(attachment.fileName)) {
    throw new CodexDesktopAdapterError(
      "control-not-configured",
      "Refusing native composer attachment with an unexpected filename.",
    );
  }
  if (
    attachment.pngBase64.length === 0
    || attachment.pngBase64.length % 4 !== 0
    || attachment.pngBase64.length > Math.ceil(MAX_COMPOSER_IMAGE_BYTES / 3) * 4
  ) {
    throw new CodexDesktopAdapterError("control-not-configured", "Refusing an invalid native composer PNG.");
  }
  const bytes = Buffer.from(attachment.pngBase64, "base64");
  if (
    bytes.length === 0
    || bytes.length > MAX_COMPOSER_IMAGE_BYTES
    || bytes.toString("base64") !== attachment.pngBase64
    || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  ) {
    throw new CodexDesktopAdapterError("control-not-configured", "Refusing an invalid native composer PNG.");
  }
}

function validateComposerBatch(batch: NativeComposerImageBatch): void {
  const threadId = extractThreadId(batch.expectedThreadId);
  if (threadId === null || threadId !== batch.expectedThreadId || batch.images.length < 1 || batch.images.length > 12) {
    throw new CodexDesktopAdapterError("invalid-thread-key", "Refusing an invalid native composer image batch.");
  }
  const names = new Set<string>();
  let total = 0;
  for (const image of batch.images) {
    if (image.expectedThreadId !== batch.expectedThreadId || names.has(image.fileName)) {
      throw new CodexDesktopAdapterError("control-not-configured", "Refusing a mismatched or duplicate image batch.");
    }
    validateComposerAttachment(image);
    names.add(image.fileName);
    total += Buffer.from(image.pngBase64, "base64").length;
  }
  if (total > MAX_COMPOSER_BATCH_BYTES) {
    throw new CodexDesktopAdapterError("control-not-configured", "Refusing a native composer image batch above 24 MiB.");
  }
}

function validateDispatch(event: NativeDispatch): void {
  if (event.kind === "agent") {
    const threadId = extractThreadId(event.threadKey);
    if (event.key !== `AG0${event.index}` || threadId === null || threadId !== event.threadKey) {
      throw new CodexDesktopAdapterError("invalid-thread-key", "Refusing an invalid native agent dispatch.");
    }
    return;
  }
  const expectedThreadId = extractThreadId(event.expectedThreadId);
  if (expectedThreadId === null || expectedThreadId !== event.expectedThreadId) {
    throw new CodexDesktopAdapterError("invalid-thread-key", "Refusing native control without a canonical expected thread UUID.");
  }
  if (event.kind === "action") {
    const expected = ({ ACT06: "ACT06", ACT07: "ACT07", ACT08: "ACT08", ACT09: "ACT09", ACT10_ACT11: "ACT10", ACT12: "ACT12" } as const)[event.slot];
    if (!Number.isInteger(event.expectedAgentSlot) || event.expectedAgentSlot < 0 || event.expectedAgentSlot > 5 || event.key !== expected) {
      throw new CodexDesktopAdapterError("control-not-configured", "Refusing a mismatched native action slot and event key.");
    }
  }
  if (event.kind === "action") {
    const safeIdentifier = (value: string): boolean => /^[A-Za-z0-9][A-Za-z0-9_.:+/-]{0,127}$/.test(value);
    if (!safeIdentifier(event.expectedKeycapId)) {
      throw new CodexDesktopAdapterError("control-not-configured", "Refusing native control without a bounded expected keycap identity.");
    }
    if (event.expectedNativeCommandId !== null && !safeIdentifier(event.expectedNativeCommandId)) {
      throw new CodexDesktopAdapterError("control-not-configured", "Refusing native control without a bounded expected command identity.");
    }
    const approvalIdentities = new Set(["appr", "approve", "accept", "approvalaccept", "rej", "reject", "decline", "deny", "approvalreject"]);
    const normalize = (value: string): string => {
      const normalized = value.toLowerCase().replace(/[^a-z0-9]/gu, "");
      return normalized.startsWith("native") ? normalized.slice("native".length) : normalized;
    };
    if (
      approvalIdentities.has(normalize(event.expectedKeycapId))
      || (event.expectedNativeCommandId !== null && approvalIdentities.has(normalize(event.expectedNativeCommandId)))
    ) {
      throw new CodexDesktopAdapterError("control-not-configured", "Approval decisions require an exact typed app-server request.");
    }
    if (!isAllowlistedNativeAction(event.slot, event.expectedKeycapId, event.expectedNativeCommandId)) {
      throw new CodexDesktopAdapterError("control-not-configured", "Refusing a native assignment outside the explicit safe allowlist.");
    }
  }
  if (event.kind === "joystick") {
    const safeIdentifier = (value: string): boolean => /^[A-Za-z0-9][A-Za-z0-9_.:+/-]{0,127}$/.test(value);
    if (event.expectedAssignment.type !== "command" || !safeIdentifier(event.expectedAssignment.commandId)) {
      throw new CodexDesktopAdapterError("control-not-configured", "Refusing native joystick control without a bounded command assignment identity.");
    }
    const normalizedCommandId = event.expectedAssignment.commandId.toLowerCase().replace(/[^a-z0-9]/gu, "");
    const withoutNativePrefix = normalizedCommandId.startsWith("native")
      ? normalizedCommandId.slice("native".length)
      : normalizedCommandId;
    if (["appr", "approve", "accept", "approvalaccept", "rej", "reject", "decline", "deny", "approvalreject"].includes(withoutNativePrefix)) {
      throw new CodexDesktopAdapterError("control-not-configured", "Approval decisions require an exact typed app-server request.");
    }
    if (!isAllowlistedNativeJoystickAction(
      event.direction,
      event.expectedAssignment.type,
      event.expectedAssignment.commandId,
    )) {
      throw new CodexDesktopAdapterError("control-not-configured", "Refusing a native joystick assignment outside the explicit safe allowlist.");
    }
  }
  if (event.kind === "reasoning") {
    const expected = event.direction === "increase" ? "ENC_CC" : "ENC_CW";
    if (event.key !== expected) {
      throw new CodexDesktopAdapterError("control-not-configured", "Refusing a mismatched reasoning direction and encoder key.");
    }
  }
  if (event.kind === "joystick" && !["up", "right", "down", "left"].includes(event.direction)) {
    throw new CodexDesktopAdapterError("control-not-configured", "Refusing an unknown native joystick direction.");
  }
  if ((event.kind === "action" || event.kind === "reasoning") && !NATIVE_CONTROL_IDENTIFIERS.includes(event.key)) {
    throw new CodexDesktopAdapterError("control-not-configured", "Refusing an unknown native control identifier.");
  }
}
