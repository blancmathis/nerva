import { NervaCardSchema, type NervaCard as NervaCardDocument } from "@codex-pad/protocol";

export function NervaCard({ document }: { readonly document: unknown }) {
  const parsed = NervaCardSchema.safeParse(document);
  if (!parsed.success) return null;
  const card: NervaCardDocument = parsed.data;
  return (
    <article className="cp-nerva-card" data-tone={card.tone}>
      <header>
        <span>{card.source === "context-room" ? "Context Room" : card.source === "codex" ? "Codex" : "Nerva"}</span>
        <h3>{card.title}</h3>
        {card.subtitle && <p>{card.subtitle}</p>}
      </header>
      <div className="cp-nerva-card__blocks">
        {card.blocks.map((block, index) => {
          if (block.type === "text") return <p key={index}>{block.text}</p>;
          if (block.type === "metric") return <div className="cp-nerva-card__metric" key={index}><span>{block.label}</span><strong>{block.value}</strong>{block.detail && <small>{block.detail}</small>}</div>;
          if (block.type === "progress") return <div className="cp-nerva-card__progress" key={index}><span><strong>{block.label}</strong><small>{block.detail}</small></span><progress value={block.value} max={1} /></div>;
          if (block.type === "list") return <div className="cp-nerva-card__list" key={index}><strong>{block.label}</strong><ul>{block.items.map((item) => <li key={item}>{item}</li>)}</ul></div>;
          return <div className="cp-nerva-card__status" data-tone={block.tone} key={index}><span>{block.label}</span><strong>{block.value}</strong></div>;
        })}
      </div>
    </article>
  );
}
