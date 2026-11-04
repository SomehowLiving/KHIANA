---
name: Khiana
description: A bright toy-arena party game where the friendliest voice in the room might be bought.
colors:
  ink: "#1B1F4B"
  ink-soft: "#464C86"
  sky: "#4FC3FF"
  sky-deep: "#1668B8"
  sky-hi: "#A8E3FF"
  sun: "#FFD23F"
  sun-lip: "#D99A00"
  pink: "#FF5FA8"
  pink-lip: "#C42E78"
  lime: "#7BD94B"
  lime-lip: "#3E9A1C"
  orange: "#FF8A3D"
  grape: "#9B6BFF"
  cream: "#FFF7E6"
  white: "#FFFFFF"
  ghost-lip: "#C7CEEA"
  placeholder: "#6B71A3"
  visor: "#23285C"
  bulb: "#FFE14D"
  eye-loyal: "#7FF3FF"
  eye-saboteur: "#FF3D7F"
  maze-sky: "#9FDBFF"
  maze-fog: "#B4E4FF"
  floor-a: "#FFF6E2"
  floor-b: "#FFE3B0"
  wall-zone-pink: "#FF9CCB"
  wall-zone-orange: "#FFB879"
  wall-zone-yellow: "#FFE07A"
  wall-zone-green: "#9EE57E"
  wall-zone-blue: "#7FD6FF"
  wall-zone-violet: "#B9A3FF"
  seat-1: "#2FB8F5"
  seat-2: "#FF8A3D"
  seat-3: "#6ED34A"
  seat-4: "#FF5FA8"
  seat-5: "#FFC93C"
  seat-6: "#5B6CFF"
  seat-7: "#22D6A0"
  seat-8: "#B070FF"
typography:
  display:
    fontFamily: "Lilita One, Nunito, system-ui, sans-serif"
    fontSize: "clamp(72px, 11vw, 150px)"
    fontWeight: 400
    lineHeight: 1.02
    letterSpacing: "0.005em"
  headline:
    fontFamily: "Lilita One, Nunito, system-ui, sans-serif"
    fontSize: "clamp(38px, 5.4vw, 64px)"
    fontWeight: 400
    lineHeight: 1.02
    letterSpacing: "0.005em"
  title:
    fontFamily: "Lilita One, Nunito, system-ui, sans-serif"
    fontSize: "24px"
    fontWeight: 400
    lineHeight: 1.02
  body:
    fontFamily: "Nunito, system-ui, -apple-system, sans-serif"
    fontSize: "17px"
    fontWeight: 700
    lineHeight: 1.55
  label:
    fontFamily: "Nunito, system-ui, -apple-system, sans-serif"
    fontSize: "14px"
    fontWeight: 800
    lineHeight: 1.1
  button:
    fontFamily: "Lilita One, Nunito, system-ui, sans-serif"
    fontSize: "20px"
    fontWeight: 400
    lineHeight: 1
    letterSpacing: "0.01em"
rounded:
  badge: "14px"
  input: "16px"
  button: "18px"
  bubble: "22px"
  panel: "26px"
  card: "28px"
  pill: "999px"
spacing:
  xs: "6px"
  sm: "10px"
  md: "14px"
  lg: "22px"
  xl: "28px"
  section: "clamp(64px, 9vw, 112px)"
components:
  button-primary:
    backgroundColor: "{colors.sun}"
    textColor: "{colors.ink}"
    typography: "{typography.button}"
    rounded: "{rounded.button}"
    padding: "14px 26px 15px"
  button-ghost:
    backgroundColor: "{colors.white}"
    textColor: "{colors.ink}"
    typography: "{typography.button}"
    rounded: "{rounded.button}"
    padding: "14px 26px 15px"
  button-lime:
    backgroundColor: "{colors.lime}"
    textColor: "{colors.ink}"
    typography: "{typography.button}"
    rounded: "{rounded.button}"
    padding: "14px 26px 15px"
  input-text:
    backgroundColor: "{colors.white}"
    textColor: "{colors.ink}"
    rounded: "{rounded.input}"
    padding: "12px 15px"
  card:
    backgroundColor: "{colors.cream}"
    textColor: "{colors.ink}"
    rounded: "{rounded.card}"
    padding: "26px"
  stat-pill:
    backgroundColor: "{colors.cream}"
    textColor: "{colors.ink}"
    typography: "{typography.label}"
    rounded: "{rounded.pill}"
    padding: "5px 14px 5px 6px"
  speech-bubble:
    backgroundColor: "{colors.white}"
    textColor: "{colors.ink}"
    rounded: "{rounded.bubble}"
    padding: "10px 18px 14px"
  value-badge:
    backgroundColor: "{colors.sun}"
    textColor: "{colors.ink}"
    rounded: "{rounded.badge}"
    padding: "2px 8px"
  ink-tag:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.white}"
    typography: "{typography.label}"
    rounded: "{rounded.pill}"
    padding: "6px 14px"
---

# Design System: Khiana

## Overview

**Creative North Star: "The Toy-Box Arena"**

Khiana is a bright party game built from toys. Every surface, in the browser and in the WebGL maze, looks like moulded plastic: a thick navy outline, a candy fill, and a darker lip underneath that makes it look pressable. The ground is an open sky-blue field with drifting polka dots and soft clouds. Cream "ground" bands with scalloped cloud tops sit between the sky sections. The cast is the antenna bean, a capsule figure with a glass visor and an antenna bulb. That bulb stands for the advisor link: it glows on a briefing and goes dark when its player is eliminated.

The world is loud but disciplined. Navy ink is the only line colour and the only dark text. Candy colours are fills, never text. Display type is a fat rounded face with a white fill, navy stroke and navy drop. Brightness never buys sight: the maze washes unseen tiles toward a pale sky fog (instead of toward black), and fog density stays where the game needs it. Colour also never shows team. Seat colours are identity only, and the one team tell is the bean's eye colour, shown only when the viewer already knows.

This is genre inspiration from the chunky party-game look the user asked for (PRODUCT.md, binding). It is original art with no borrowed branding or characters, and it rejects the dark neon-noir sci-fi look the project shipped before.

**Key Characteristics:**
- Navy (#1B1F4B) outline on every object, in CSS borders and in the 3D inverted-hull outline alike.
- Pressable toys: a hard navy lip directly below, plus a soft navy-tinted cast shadow.
- Candy fills on a sky ground; cream for panels; white for things you type into or read from.
- Lilita One for everything you shout, Nunito 700 to 900 for everything you read.
- Springy, toy-like motion that is fully disabled under reduced motion.

## Colors

The palette is candy primaries on an open sky, held together by one navy ink.

### Primary
- **Party Sun** (sun): the main call to action (Play, Enter the maze, Open a table). It also fills value badges (room code, retainer value, powerup prices, compass distance), the tick bar, the focus ring and the text selection. Its lip is **Sun Lip** (sun-lip).
- **Arena Sky** (sky): the world's ground. It drives the party-sky gradient (with **Sky Highlight** (sky-hi) as the overhead glow), the Loyalist role colour and the HUD stat icon discs. **Deep Sky** (sky-deep) is the speaker colour on advisor bubbles and the scrollbar track.

### Secondary
- **Bubblegum** (pink): the Saboteur role colour, the saboteur stalk readout, the compass needle, the elimination title and "live" badges. Its lip is **Bubblegum Lip** (pink-lip), which is also the input caret colour.
- **Lime Pop** (lime): the exit-open state, filled lobby seats and step markers. Its lip is **Lime Lip** (lime-lip).

### Tertiary
- **Tangerine** (orange) and **Grape** (grape): spare candy fills, used through the seat set and the slider gradient rather than on chrome.
- **Seat colours** (seat-1 to seat-8): one per seat on every bean, roster dot and result dot. They carry identity only and must stay in sync with the spectator app.
- **Eye lights**: **Loyal Cyan** (eye-loyal) and **Saboteur Rose** (eye-saboteur), the only team tell in the 3D world. **Antenna Bulb** (bulb) is the advisor link at idle. **Visor Navy** (visor) is the glass on every bean.
- **Maze world**: **Maze Sky** (maze-sky) and **Maze Fog** (maze-fog) over a **Cream Checker** floor (floor-a / floor-b). Walls are toy blocks tinted with six pastel zones (wall-zone-pink, wall-zone-orange, wall-zone-yellow, wall-zone-green, wall-zone-blue, wall-zone-violet).

### Neutral
- **Toy Navy** (ink): every outline, every lip, all body and display-stroke colour, dark tags and the footer.
- **Soft Navy** (ink-soft): secondary copy, metadata and captions on cream and white.
- **Cream Panel** (cream): cards, nav bar, HUD pills, roster, ground bands.
- **White** (white): speech bubbles, inputs, ghost buttons, step cards and the display-type fill.
- **Ghost Lip** (ghost-lip): the lip under white ghost buttons. **Placeholder Navy** (placeholder): input placeholders.

### Named Rules
**The One Ink Rule.** Navy is the only line and the only dark text. No greys and no black: shadows are navy-tinted (rgba(27,31,75,…)), and dimmed states use opacity on navy.

**The Seat Is Not a Team Rule.** Seat colours, wall zones and panel fills never encode team. Team colour (sky for Loyalist, pink for Saboteur) appears only to a player who already knows it: their own role pill, a fellow saboteur's eyes, and the end-of-round reveal.

**The Bright Fog Rule.** Out-of-sight geometry fades toward the pale sky fog colour (a 55% blend toward maze-fog), never toward black, and never by thinning the fog.

## Typography

**Display Font:** Lilita One (with Nunito, system-ui)
**Body Font:** Nunito, loaded at 600 to 900 (with system-ui, -apple-system)

**Character:** A fat, rounded poster face used like a toy decal, over a sturdy rounded sans that is always set heavy. Body text never drops below 700.

### Hierarchy
- **Display** (400, clamp(72px, 11vw, 150px), 1.02): the KHIANA hero title, set at a -3deg tilt. White fill, 9px navy stroke with stroke painted first, 9px navy drop. The join card title (clamp(52px, 7vw, 84px)) uses the same treatment. Elimination and reveal titles keep the stroke and drop over a pink or sky fill.
- **Headline** (400, clamp(38px, 5.4vw, 64px), 1.02): section titles, with a 5px stroke and 5px drop.
- **Title** (400, 24px to 36px): card and step headings in solid navy. Role and FAQ lead headings switch to the white-fill, navy-stroke treatment.
- **Body** (700, 17px, 1.55): paragraph copy, kept to about 60ch. Ledes and the advisor briefing step up to 800, at 18px.
- **Label** (800 to 900, 11px to 15px): HUD stats, roster rows, metadata and tags. Numbers use tabular figures.
- **Button** (Lilita One 400, 20px; 28px for the hero and join CTAs): every pressable label.

### Named Rules
**The Sticker Title Rule.** Any white display text gets a navy stroke (painted under the fill) and a straight-down navy drop at the stroke's own width (6px default, 5px headline, 9px hero). White display text without the stroke is not allowed.

**The Heavy Floor Rule.** Nunito is never set below 700. Everyday UI weight is 800, and emphasis is 900.

## Layout

The landing is a single column inside a 1180px wrap (min(100% - 32px, 1180px)). Sections get generous vertical padding (section spacing) and alternate between sky and cream ground bands. The hero is a two-column grid (.95fr / 1.05fr) with the WebGL podium stage on the right; below 900px it stacks, stage first. Cards sit in auto-filling grids (lobbies at minmax(270px, 1fr)) with a 22px gap, and some are deliberately tilted (±1.2deg) or staggered like a board-game track.

The game is a full-bleed WebGL stage with HUD pieces fixed at the edges. Stat pills run across the top-left, the roster sits top-right (196px), the compass hangs below the stat row on the left, and the advisor speech bubble is centred at the bottom (max 720px). A 10px tick bar spans the very top. Below 700px the HUD compacts: labels drop out, pills and type shrink, and the objective moves above the briefing. The d-pad appears only on coarse-pointer devices. Overlays (join, lobby, reveal) are centred screens on the party sky.

## Elevation & Depth

Depth is physical, like a toy, and uses two layers that are always paired. The first is a hard navy lip directly below the object (0 4px to 0 8px, no blur). It is the toy's moulded base and it shrinks when the object is pressed. The second is a soft navy-tinted cast shadow beneath it that grounds the object on the sky. Small inline pieces (badges, chips, seats) may carry the lip alone. Buttons add an inner bottom lip in their own darker shade. Elevation is never expressed with grey or black shadows or with blur alone.

### Shadow Vocabulary
- **Card lift** (`box-shadow: 0 8px 0 #1B1F4B, 0 18px 30px rgba(27,31,75,.28)`): cards and overlay panels.
- **Button rest** (`box-shadow: inset 0 -5px 0 <lip>, 0 5px 0 #1B1F4B, 0 10px 16px rgba(27,31,75,.25)`): every button.
- **HUD pill** (`box-shadow: 0 4px 0 #1B1F4B, 0 8px 14px rgba(27,31,75,.25)`): stat pills; the roster and bubble use 5px with a larger blur.
- **Inline lip** (`box-shadow: 0 4px 0 #1B1F4B` to `0 7px 0 #1B1F4B`): chips, step cards, result cards, lobby cards and badges.
- **Input well** (`box-shadow: inset 0 4px 0 rgba(27,31,75,.08)`): text fields sit slightly recessed.

### Named Rules
**The Lip Rule.** Anything pressable or liftable stands on a navy lip directly below it, offset straight down and never sideways. Pressing pushes the object down into its lip.

## Shapes

Everything is rounded and outlined. Borders are 3px to 4px navy (3.5px on buttons and inputs, 4px on cards; 2px to 2.5px on the smallest badges and icon discs). Corners scale with size: badge 14px, input 16px, button 18px, bubble 22px, panel 26px, card 28px, and fully round pills for stats, tags, seats and the slider. Speech bubbles have a rotated-square tail that shares the bubble's outline. Ground bands begin with a scalloped cloud edge. In 3D, the same language holds: capsule beans with a navy inverted-hull outline (1.07 to 1.25 scale), three-band toon shading, and toy-block walls with rounded seams, a bevel highlight and a stud.

## Components

### Buttons
Chunky toys you press into their lip.
- **Shape:** gently pillowed corners (18px), 3.5px navy border.
- **Primary:** sun face over a sun-lip inner lip, navy label in Lilita One 20px, padding 14px 26px 15px. Hero and join CTAs scale to 28px.
- **Hover / Focus:** rises 2px with a deeper lip and 5% brightness. Active drops 5px and the lip collapses. Focus is a 4px sun outline at a 3px offset.
- **Ghost:** white face over ghost-lip; used for secondary actions, nav Play, Copy, Refresh and the d-pad.
- **Lime:** lime face over lime-lip with a navy label. It is defined in the stylesheet but no current surface uses it.
- **Disabled:** saturation 0.4, opacity 0.75.

### Chips
- **Style:** white with a 3.5px navy border, 18px corners and a 5px lip. A Lilita name sits beside a sun price pill.
- **State:** on hover, rises 3px and tilts -1.5deg on the spring curve.

### Cards / Containers
- **Corner Style:** 26px to 28px.
- **Background:** cream for panels; white for step cards and FAQ; team-coloured role cards on the landing only.
- **Shadow Strategy:** card lift or inline lip (see Elevation & Depth).
- **Border:** 4px navy.
- **Internal Padding:** 20px to 30px.

### Inputs / Fields
- **Style:** white well, 3.5px navy border, 16px corners, Nunito 800 at 17px, pink-lip caret.
- **Focus:** 4px sun outline.
- **Slider:** a round pill track with a pink-to-sun-to-lime gradient and a navy outline, plus a white round thumb on a 3px lip. The value shows in a sun badge beside it.
- **Labels:** Lilita One 18px in navy above the field.

### Navigation
- **Style:** a sticky cream bar with 22px corners, a 3.5px navy border and a 5px lip, floating 12px from the top. Links are Nunito 900 at 15px. On hover a 3px pink underline fades in. A ghost Play button sits at the end. Below 760px, links hide and only the brand and Play remain.

### HUD Stat Pill (signature)
A cream pill with a navy-outlined icon disc in sky (sun for tasks, lime for exit), a small Nunito label and a Lilita value in tabular figures. The exit pill turns lime and pulses once the exit opens. The role pill fills with the player's own team colour.

### Advisor Speech Bubble (signature)
A sun-yellow bean avatar disc beside a white bubble with a tail. The speaker line is in Lilita One, sky-deep, at 16px; the message is Nunito 800 at 18px. The avatar pings (scales and tilts) on each new briefing. The landing hero reuses the same bubble above the podium.

### Antenna Bean (signature)
The procedural toon capsule character, in its seat colour with a lighter belly patch, a visor-navy glass with two eye lights, stubby outlined limbs and an antenna bulb. The bulb glows on briefing and dims to grey-navy on elimination, when the eyes darken too. It appears on the landing podium, the join pedestal, in the maze and on the reveal stage.

## Do's and Don'ts

### Do:
- **Do** outline every object in navy (#1B1F4B) at 3px to 4px, and give pressable or lifted things a straight-down navy lip plus a soft navy-tinted cast shadow.
- **Do** use sun (#FFD23F) for the one main action on a screen and for value badges.
- **Do** set white display type with a navy stroke painted under the fill and a matching navy drop.
- **Do** keep Nunito at 700 or heavier and use tabular figures for every live number.
- **Do** fade unseen maze geometry toward the pale fog (#B4E4FF) and keep fog density unchanged.
- **Do** turn off every drift, pulse, stamp and spring animation under prefers-reduced-motion.

### Don't:
- **Don't** use seat colours, wall zones or panel fills to signal team. Team colour appears only to a viewer who already knows it.
- **Don't** introduce grey, black or sideways-offset shadows. Depth is a navy lip directly below plus a navy-tinted blur.
- **Don't** set candy colours (sun, pink, lime, sky) as text on cream or white. Text is navy; white or candy fills appear only inside a navy-stroked display treatment, and white also on a navy tag.
- **Don't** brighten the maze by thinning fog or extending sight; re-tint instead.
- **Don't** use Stumble Guys branding, characters or art. The genre look is inspiration only.
