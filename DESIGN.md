---
name: Nerva
description: A tactile Apple-inspired control surface for agentic development
colors:
  canvas-dark: "#090b0f"
  content-dark: "#151820"
  content-raised-dark: "#1b1f28"
  ink-dark: "rgba(255, 255, 255, .96)"
  ink-secondary-dark: "rgba(239, 242, 248, .68)"
  canvas-light: "#eef0f5"
  content-light: "#ffffff"
  ink-light: "rgba(18, 22, 31, .94)"
  signal-blue: "#67a2ff"
  signal-green: "#5ed3a3"
  signal-amber: "#ffbd63"
  signal-red: "#ff716b"
  signal-violet: "#bb9cff"
  signal-silver: "#b8c0cf"
typography:
  display:
    fontFamily: "-apple-system, BlinkMacSystemFont, SF Pro Display, Helvetica Neue, sans-serif"
    fontSize: "32px"
    fontWeight: 700
    lineHeight: 1.08
    letterSpacing: "-0.025em"
  body:
    fontFamily: "-apple-system, BlinkMacSystemFont, SF Pro Text, Helvetica Neue, sans-serif"
    fontSize: "15px"
    fontWeight: 450
    lineHeight: 1.45
    letterSpacing: "normal"
  label:
    fontFamily: "-apple-system, BlinkMacSystemFont, SF Pro Text, Helvetica Neue, sans-serif"
    fontSize: "13px"
    fontWeight: 650
    lineHeight: 1.2
    letterSpacing: "normal"
  denseScale:
    description: "Optical substeps used only for compact metadata, live browser chrome and icon glyphs; never for primary reading copy."
    values: ["9px", "10px", "11px", "12px", "14px", "18px", "21px", "24px", "28px"]
rounded:
  micro: "9px"
  xs: "10px"
  compact: "11px"
  control: "12px"
  input: "13px"
  sm: "14px"
  address: "15px"
  card: "16px"
  floating: "17px"
  md: "18px"
  glass: "20px"
  panel: "22px"
  lg: "24px"
  xl: "30px"
  round: "999px"
spacing:
  xs: "6px"
  sm: "10px"
  md: "16px"
  lg: "24px"
  xl: "32px"
components:
  button-primary:
    backgroundColor: "{colors.signal-blue}"
    textColor: "#ffffff"
    rounded: "{rounded.sm}"
    height: "52px"
    padding: "0 18px"
  content-surface:
    backgroundColor: "{colors.content-dark}"
    textColor: "{colors.ink-dark}"
    rounded: "{rounded.lg}"
    padding: "20px"
---

# Design System: Nerva

## Overview

**Creative North Star: "The Luminous Control Deck"**

Nerva combines the structural calm of iPadOS with the physical confidence of a purpose-built control surface. The content remains sober and legible; light appears only where it communicates a live state, a selected target, or an action ready to happen. Controls should feel pressed, not merely recolored.

The interface is an operating surface, not a marketing display. Glass belongs to navigation and floating layers. Work areas, lists, editors, and forms are opaque so that dense information stays stable under fingers and Pencil.

**Key Characteristics:**

- restrained adaptive palette with local semantic light;
- large, forgiving touch geometry;
- opaque content planes beneath thin navigation glass;
- physical controls with a top highlight, grounded shadow, and compressed active state;
- calm system typography and short English action labels.

## Colors

The palette is neutral until state or intent earns color. Working blue, completed green, approval amber, error red, waiting violet, and idle silver remain semantic and consistent.

**The Local Light Rule.** Color may illuminate an active control or state region; it must not wash unrelated content or become ambient decoration.

## Typography

**Display Font:** SF Pro Display through the Apple system stack

**Body Font:** SF Pro Text through the Apple system stack

**Label/Mono Font:** SFMono only for technical values, identifiers, durations, and measured data

The hierarchy is compact and native. Product screens use one sans family, strong titles, quiet explanatory text, and labels that remain readable without tracked uppercase styling.

## Layout

Primary tablet surfaces use full-width composition with content inset by safe areas. iPad landscape may use a stable sidebar plus work area; portrait collapses secondary context into drawers or sheets; phone uses one column and bottom sheets. Responsive behavior changes structure rather than shrinking type or touch targets.

## Elevation & Depth

Depth is hybrid: opaque surfaces are separated tonally, physical action keys use the canonical inset highlight plus grounded shadow, and floating navigation uses the glass token with blur. Content cards do not combine a full border and a heavy shadow.

## Shapes

Controls use 10–18 px corners; substantial sheets and work surfaces use 24–30 px. Pills are reserved for compact segmented controls, status, and short metadata. The minimum touch target is 44 px, with primary actions normally 52 px or taller.

## Components

### Buttons

Primary buttons are tactile keys with one semantic color, white foreground, a top highlight, a grounded shadow, and a short compressed active state. Secondary buttons use the content-raised neutral and become brighter only on focus, hover, or press. Disabled controls lose elevation and color without becoming illegible.

### Cards / Containers

Content surfaces are opaque. They use tonal separation and one subtle inner highlight. Nested glass is forbidden. Lists use rhythm and separators before inventing an additional card.

### Inputs / Fields

Inputs are at least 52 px high on touch surfaces. The field background is opaque, the focus ring uses signal blue, validation text names both the problem and recovery, and placeholder contrast remains accessible.

### Navigation

Top bars, docks, and sheets may use Liquid Glass when they float above content. Navigation labels remain short, familiar, and accompanied by a standard icon only when the icon reduces search time.

### Agent Key

The signature control is a luminous physical key: material depth at rest, local state light, 1–2 px compression on touch, and spring release. It is reserved for consequential session or input actions.

## Do's and Don'ts

### Do:

- **Do** preserve 44 px minimum targets and generous spacing between unrelated actions.
- **Do** keep important state visible without requiring a sheet or hover.
- **Do** make loading, degraded, empty, offline, and error states structurally complete.
- **Do** use motion only to explain state change, transfer, opening, or physical press.

### Don't:

- **Don't** place glass behind long-form content, lists, or editors.
- **Don't** use color as decoration disconnected from state or intent.
- **Don't** shrink cards or controls merely to avoid scrolling.
- **Don't** rely on perfect horizontal gestures, hover, or mouse precision.
- **Don't** simulate unavailable functionality or hide the exact destination of an action.
