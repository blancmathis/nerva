import { useCallback, useEffect, useMemo, useState } from "react";
import type { OpenBrowserTab, OpenBrowserTabsResult } from "../lib/bridge-client";
import { createUuidV4 } from "../lib/uuid";
import type { SiteFavorite } from "../lib/storage";
import { ChevronIcon, GlobeIcon } from "./Icons";

interface SiteHubPageProps {
  readonly threadId: string;
  readonly threadTitle: string;
  readonly favorites: readonly SiteFavorite[];
  readonly fetchBrowserTabs: (threadId: string) => Promise<OpenBrowserTabsResult>;
  readonly onOpenTab: (tab: OpenBrowserTab) => void;
  readonly onNavigateTab: (tab: OpenBrowserTab, url: string) => Promise<void>;
  readonly onFavoritesChange: (favorites: readonly SiteFavorite[]) => void;
  readonly onBack: () => void;
}

function displayLocation(value: string): string {
  try {
    const url = new URL(value);
    return `${url.hostname}${url.port ? `:${url.port}` : ""}${url.pathname === "/" ? "" : url.pathname}`;
  } catch {
    return value;
  }
}

export function normalizeSiteAddress(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error("Enter a site address.");
  const localAddress = /^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?(?:\/|$)/iu.test(trimmed);
  if (!localAddress && /^[a-z][a-z0-9+.-]*:/iu.test(trimmed) && !/^https?:\/\//iu.test(trimmed)) {
    throw new Error("Use an HTTP(S) address without embedded credentials.");
  }
  const withProtocol = /^[a-z][a-z0-9+.-]*:\/\//iu.test(trimmed)
    ? trimmed
    : localAddress
      ? `http://${trimmed}`
      : `https://${trimmed}`;
  const url = new URL(withProtocol);
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password || url.href.length > 2_048) {
    throw new Error("Use an HTTP(S) address without embedded credentials.");
  }
  return url.href;
}

function defaultFavoriteLabel(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.hostname.replace(/^www\./u, "") || "Favorite site";
  } catch {
    return "Favorite site";
  }
}

export function SiteHubPage({
  threadId,
  threadTitle,
  favorites,
  fetchBrowserTabs,
  onOpenTab,
  onNavigateTab,
  onFavoritesChange,
  onBack,
}: SiteHubPageProps) {
  const [tabs, setTabs] = useState<readonly OpenBrowserTab[]>([]);
  const [detail, setDetail] = useState("Looking for this task's open Codex Browser pages…");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [address, setAddress] = useState("");
  const [targetTabId, setTargetTabId] = useState("");
  const [opening, setOpening] = useState(false);
  const [query, setQuery] = useState("");

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await fetchBrowserTabs(threadId);
      setTabs(result.tabs);
      setDetail(result.detail);
      setTargetTabId((current) => result.tabs.some((tab) => tab.id === current && tab.controllable)
        ? current
        : result.tabs.find((tab) => tab.controllable)?.id ?? "");
    } catch (caught) {
      setTabs([]);
      setError(caught instanceof Error ? caught.message : "Open pages could not be loaded.");
    } finally {
      setLoading(false);
    }
  }, [fetchBrowserTabs, threadId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);
  useEffect(() => {
    document.querySelector<HTMLElement>(".cp-app-content")?.scrollTo({ top: 0, left: 0, behavior: "instant" });
  }, []);

  const selectedTab = tabs.find((tab) => tab.id === targetTabId && tab.controllable) ?? null;
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const visibleTabs = useMemo(() => normalizedQuery === "" ? tabs : tabs.filter((tab) => (
    tab.title.toLocaleLowerCase().includes(normalizedQuery) || tab.url.toLocaleLowerCase().includes(normalizedQuery)
  )), [normalizedQuery, tabs]);
  const visibleFavorites = useMemo(() => normalizedQuery === "" ? favorites : favorites.filter((favorite) => (
    favorite.label.toLocaleLowerCase().includes(normalizedQuery) || favorite.url.toLocaleLowerCase().includes(normalizedQuery)
  )), [favorites, normalizedQuery]);

  async function openAddress(value: string) {
    if (!selectedTab || opening) return;
    setOpening(true);
    setError(null);
    try {
      const normalized = normalizeSiteAddress(value);
      await onNavigateTab(selectedTab, normalized);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The site could not be opened.");
    } finally {
      setOpening(false);
    }
  }

  function addFavorite(value: string) {
    try {
      const url = normalizeSiteAddress(value);
      if (favorites.some((favorite) => favorite.url === url)) return;
      onFavoritesChange([...favorites, {
        id: createUuidV4(),
        label: defaultFavoriteLabel(url),
        url,
        updatedAt: Date.now(),
      }]);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "This favorite could not be saved.");
    }
  }

  return (
    <main className="cp-sites-hub" aria-labelledby="sites-hub-title">
      <header className="cp-sites-hub__header">
        <button type="button" className="cp-sites-hub__back" onClick={onBack}><ChevronIcon direction="left" />Session</button>
        <div>
          <p className="cp-overline">Codex Browser · {threadTitle}</p>
          <h1 id="sites-hub-title">Sites</h1>
          <p>Browse, annotate, and record a precise reproduction without leaving this task.</p>
        </div>
        <button type="button" className="cp-sites-hub__refresh" disabled={loading} onClick={() => void refresh()}>{loading ? "Refreshing…" : "Refresh pages"}</button>
      </header>

      <form className="cp-site-address" onSubmit={(event) => { event.preventDefault(); void openAddress(address); }}>
        <span className="cp-site-address__icon"><GlobeIcon /></span>
        <label><span className="sr-only">Site address</span><input inputMode="url" autoCapitalize="none" autoCorrect="off" spellCheck={false} value={address} placeholder="Enter a URL or domain" onChange={(event) => setAddress(event.target.value)} /></label>
        <label className="cp-site-address__target"><span>Open in</span><select aria-label="Codex Browser page to navigate" value={targetTabId} onChange={(event) => setTargetTabId(event.target.value)}>{tabs.filter((tab) => tab.controllable).map((tab) => <option key={tab.id} value={tab.id}>{tab.title || displayLocation(tab.url)}</option>)}</select></label>
        <button type="button" className="cp-site-address__favorite" disabled={!address.trim()} aria-label="Add address to favorites" onClick={() => addFavorite(address)}>☆</button>
        <button type="submit" className="cp-site-address__go" disabled={!selectedTab || !address.trim() || opening}>{opening ? "Opening…" : "Go"}</button>
      </form>

      {!loading && tabs.filter((tab) => tab.controllable).length === 0 && (
        <p className="cp-sites-hub__notice">Open at least one Browser page from this Codex task on the Mac. Nerva navigates only a page whose task ownership the bridge can prove.</p>
      )}
      {error && <p className="cp-sites-hub__error" role="status">{error}</p>}

      <div className="cp-sites-hub__toolbar">
        <label><span className="sr-only">Filter sites</span><input type="search" value={query} placeholder="Search pages and favorites" onChange={(event) => setQuery(event.target.value)} /></label>
        <span>{tabs.length} open · {favorites.length} favorite{favorites.length === 1 ? "" : "s"}</span>
      </div>

      <div className="cp-sites-hub__grid">
        <section className="cp-site-library" aria-labelledby="open-pages-title">
          <div className="cp-site-library__heading"><div><p className="cp-overline">Live on your Mac</p><h2 id="open-pages-title">Open pages</h2></div><span>{tabs.length}</span></div>
          <p className="cp-site-library__detail">{detail}</p>
          {loading ? <div className="cp-site-library__empty">Reading Codex Browser…</div> : visibleTabs.length === 0 ? (
            <div className="cp-site-library__empty"><GlobeIcon /><strong>No matching page</strong><span>Only pages attached to this exact Codex task appear here.</span></div>
          ) : (
            <div className="cp-site-card-list">
              {visibleTabs.map((tab) => (
                <article key={tab.id} className={`cp-site-card${tab.controllable ? "" : " is-unavailable"}`}>
                  <button type="button" className="cp-site-card__open" disabled={!tab.controllable} aria-label={`Open ${tab.title || "untitled page"}`} onClick={() => onOpenTab(tab)}>
                    <span className="cp-site-card__glyph"><GlobeIcon /></span>
                    <span className="cp-site-card__copy"><strong>{tab.title || "Untitled page"}</strong><small>{displayLocation(tab.url)}</small>{!tab.controllable && <em>{tab.reason ?? "This page is unavailable."}</em>}</span>
                    <span className="cp-site-card__arrow">Open</span>
                  </button>
                  <button type="button" className="cp-site-card__star" aria-label={`Favorite ${tab.title}`} aria-pressed={favorites.some((favorite) => favorite.url === tab.url)} onClick={() => {
                    const existing = favorites.find((favorite) => favorite.url === tab.url);
                    if (existing) onFavoritesChange(favorites.filter((favorite) => favorite.id !== existing.id));
                    else addFavorite(tab.url);
                  }}>{favorites.some((favorite) => favorite.url === tab.url) ? "★" : "☆"}</button>
                </article>
              ))}
            </div>
          )}
        </section>

        <section className="cp-site-library cp-site-library--favorites" aria-labelledby="favorite-sites-title">
          <div className="cp-site-library__heading"><div><p className="cp-overline">Your workspace</p><h2 id="favorite-sites-title">Favorites</h2></div><span>{favorites.length}</span></div>
          <p className="cp-site-library__detail">Saved globally and available from every paired iPad.</p>
          {visibleFavorites.length === 0 ? (
            <div className="cp-site-library__empty"><span className="cp-site-library__empty-star">☆</span><strong>{favorites.length === 0 ? "Keep important environments close" : "No matching favorite"}</strong><span>Star an open page or type an address above.</span></div>
          ) : (
            <div className="cp-favorite-list">
              {visibleFavorites.map((favorite) => (
                <article key={favorite.id} className="cp-favorite-card">
                  <button type="button" disabled={!selectedTab || opening} onClick={() => void openAddress(favorite.url)}><span>★</span><span><strong>{favorite.label}</strong><small>{displayLocation(favorite.url)}</small></span></button>
                  <button type="button" aria-label={`Remove ${favorite.label} from favorites`} onClick={() => onFavoritesChange(favorites.filter((candidate) => candidate.id !== favorite.id))}>Remove</button>
                </article>
              ))}
            </div>
          )}
        </section>
      </div>
    </main>
  );
}
