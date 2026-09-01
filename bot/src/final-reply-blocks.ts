import { splitProgressMarkdown } from "./progress-markdown";

const MAX_TABLE_ROWS = 100;
const MAX_TABLE_COLUMNS = 20;
const MAX_TABLE_CHARACTERS = 10_000;

type RichTextStyle = Partial<Record<"bold" | "italic" | "strike" | "code", true>>;
type RichTextElement = Record<string, unknown>;

type ParsedMarkdownTable = {
  startLine: number;
  endLine: number;
  headerLine: string;
  delimiterLine: string;
  bodyRows: string[][];
  rows: string[][];
  columnSettings: Array<{ align: "left" | "center" | "right"; is_wrapped: true }>;
  hasNativeColumnShape: boolean;
};

function unescaped(text: string, index: number) {
  let backslashes = 0;
  for (let cursor = index - 1; cursor >= 0 && text[cursor] === "\\"; cursor -= 1) backslashes += 1;
  return backslashes % 2 === 0;
}

function splitMarkdownTableRow(line: string): string[] | null {
  if (/^(?: {4}|\t)/.test(line)) return null;
  const text = line.trim();
  const cells: string[] = [];
  let cell = "";
  let codeMarkerLength = 0;
  let separators = 0;
  let firstWasSeparator = false;
  let lastWasSeparator = false;

  for (let index = 0; index < text.length;) {
    const character = text[index]!;
    if (character === "\\" && index + 1 < text.length) {
      cell += character + text[index + 1]!;
      index += 2;
      lastWasSeparator = false;
      continue;
    }
    if (character === "`") {
      let runLength = 1;
      while (text[index + runLength] === "`") runLength += 1;
      if (codeMarkerLength === 0) codeMarkerLength = runLength;
      else if (codeMarkerLength === runLength) codeMarkerLength = 0;
      cell += text.slice(index, index + runLength);
      index += runLength;
      lastWasSeparator = false;
      continue;
    }
    if (character === "|" && codeMarkerLength === 0) {
      if (separators === 0 && cell === "") firstWasSeparator = true;
      cells.push(cell.trim());
      cell = "";
      separators += 1;
      lastWasSeparator = true;
      index += 1;
      continue;
    }
    cell += character;
    lastWasSeparator = false;
    index += 1;
  }

  if (separators === 0) return null;
  cells.push(cell.trim());
  if (firstWasSeparator) cells.shift();
  if (lastWasSeparator) cells.pop();
  return cells;
}

function delimiterAlignment(cell: string): "left" | "center" | "right" | null {
  const delimiter = cell.trim();
  if (!/^:?-{3,}:?$/.test(delimiter)) return null;
  if (delimiter.startsWith(":") && delimiter.endsWith(":")) return "center";
  if (delimiter.endsWith(":")) return "right";
  return "left";
}

function parseMarkdownTables(markdown: string): ParsedMarkdownTable[] {
  const lines = markdown.split("\n");
  const tables: ParsedMarkdownTable[] = [];
  let fence: { character: string; length: number } | null = null;

  for (let index = 0; index < lines.length;) {
    const fenceMatch = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(lines[index]!);
    if (fenceMatch) {
      const marker = fenceMatch[1]!;
      if (!fence) fence = { character: marker[0]!, length: marker.length };
      else if (marker[0] === fence.character
        && marker.length >= fence.length
        && !fenceMatch[2]!.trim()) fence = null;
      index += 1;
      continue;
    }
    if (fence || index + 1 >= lines.length) {
      index += 1;
      continue;
    }

    const header = splitMarkdownTableRow(lines[index]!);
    const delimiters = splitMarkdownTableRow(lines[index + 1]!);
    const alignments = delimiters?.map(delimiterAlignment) || [];
    if (!header?.length
      || header.length !== delimiters?.length
      || alignments.some((alignment) => alignment === null)) {
      index += 1;
      continue;
    }

    const bodyRows: string[][] = [];
    let cursor = index + 2;
    while (cursor < lines.length) {
      const row = splitMarkdownTableRow(lines[cursor]!);
      if (!row) break;
      bodyRows.push(row);
      cursor += 1;
    }

    const columnCount = header.length;
    const hasOverflowRow = bodyRows.some((row) => row.length > columnCount);
    const normalizedRows = [header, ...bodyRows.map((row) => [
      ...row,
      ...Array.from({ length: Math.max(0, columnCount - row.length) }, () => ""),
    ])];
    tables.push({
      startLine: index,
      endLine: cursor - 1,
      headerLine: lines[index]!,
      delimiterLine: lines[index + 1]!,
      bodyRows,
      rows: normalizedRows,
      columnSettings: alignments.map((align) => ({
        align: align!,
        is_wrapped: true,
      })),
      hasNativeColumnShape: !hasOverflowRow && columnCount <= MAX_TABLE_COLUMNS,
    });
    index = cursor;
  }

  return tables;
}

function sameStyle(left: unknown, right: RichTextStyle) {
  return JSON.stringify(left || {}) === JSON.stringify(right);
}

function appendText(elements: RichTextElement[], text: string, style: RichTextStyle) {
  if (!text) return;
  const previous = elements.at(-1);
  if (previous?.type === "text" && sameStyle(previous.style, style)) {
    previous.text = `${String(previous.text)}${text}`;
    return;
  }
  elements.push({ type: "text", text, ...(Object.keys(style).length ? { style } : {}) });
}

function isMarkdownEscapable(character: string) {
  const code = character.codePointAt(0) || 0;
  return (code >= 0x21 && code <= 0x2f)
    || (code >= 0x3a && code <= 0x40)
    || (code >= 0x5b && code <= 0x60)
    || (code >= 0x7b && code <= 0x7e);
}

function unescapeMarkdownPunctuation(text: string) {
  let result = "";
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === "\\" && index + 1 < text.length && isMarkdownEscapable(text[index + 1]!)) {
      result += text[index + 1]!;
      index += 1;
    } else {
      result += text[index]!;
    }
  }
  return result;
}

function markdownLinkAt(text: string, start: number) {
  if (text[start] !== "[") return null;
  let labelEnd = start + 1;
  for (; labelEnd < text.length; labelEnd += 1) {
    if (text[labelEnd] === "]" && unescaped(text, labelEnd)) break;
  }
  if (labelEnd >= text.length || text[labelEnd + 1] !== "(") return null;

  const destinationStart = labelEnd + 2;
  let depth = 1;
  let destinationEnd = destinationStart;
  for (; destinationEnd < text.length; destinationEnd += 1) {
    const character = text[destinationEnd]!;
    if (/\s/.test(character)) return null;
    if (!unescaped(text, destinationEnd)) continue;
    if (character === "(") depth += 1;
    else if (character === ")") {
      depth -= 1;
      if (depth === 0) break;
    }
  }
  if (depth !== 0) return null;
  const url = unescapeMarkdownPunctuation(text.slice(destinationStart, destinationEnd));
  if (!/^(?:https?:\/\/|mailto:)/.test(url)) return null;
  return {
    label: unescapeMarkdownPunctuation(text.slice(start + 1, labelEnd)),
    length: destinationEnd - start + 1,
    url,
  };
}

function findClosingDelimiter(text: string, delimiter: string, start: number) {
  for (let index = start; index <= text.length - delimiter.length; index += 1) {
    const closesInsideWord = delimiter.includes("_")
      && /[\p{L}\p{N}]/u.test(text[index - 1] || "")
      && /[\p{L}\p{N}]/u.test(text[index + delimiter.length] || "");
    if (text.startsWith(delimiter, index)
      && unescaped(text, index)
      && index > start
      && !/\s/.test(text[index - 1]!)
      && !closesInsideWord) return index;
  }
  return -1;
}

function parseInlineMarkdown(text: string, style: RichTextStyle = {}): RichTextElement[] {
  const elements: RichTextElement[] = [];
  for (let index = 0; index < text.length;) {
    if (text[index] === "\\"
      && index + 1 < text.length
      && isMarkdownEscapable(text[index + 1]!)) {
      appendText(elements, text[index + 1]!, style);
      index += 2;
      continue;
    }

    const codeMarker = /^(`+)([^\n]*?)\1/.exec(text.slice(index));
    if (codeMarker) {
      appendText(elements, codeMarker[2]!, { ...style, code: true });
      index += codeMarker[0].length;
      continue;
    }

    const lineBreak = /^<br\s*\/?>/i.exec(text.slice(index));
    if (lineBreak) {
      appendText(elements, "\n", style);
      index += lineBreak[0].length;
      continue;
    }

    const markdownLink = markdownLinkAt(text, index);
    if (markdownLink) {
      elements.push({
        type: "link",
        url: markdownLink.url,
        text: markdownLink.label,
        ...(Object.keys(style).length ? { style } : {}),
      });
      index += markdownLink.length;
      continue;
    }

    const slackLink = /^<((?:https?:\/\/|mailto:)[^>|]*?)(?:(?:\\\||\|)([^>]+))?>/.exec(text.slice(index));
    if (slackLink) {
      elements.push({
        type: "link",
        url: unescapeMarkdownPunctuation(slackLink[1]!),
        ...(slackLink[2] ? { text: unescapeMarkdownPunctuation(slackLink[2]) } : {}),
        ...(Object.keys(style).length ? { style } : {}),
      });
      index += slackLink[0].length;
      continue;
    }

    const userMention = /^<@([A-Z0-9]+)>/.exec(text.slice(index));
    if (userMention) {
      elements.push({
        type: "user",
        user_id: userMention[1],
        ...(Object.keys(style).length ? { style } : {}),
      });
      index += userMention[0].length;
      continue;
    }

    const channelMention = /^<#([A-Z0-9]+)(?:(?:\\\||\|)[^>]+)?>/.exec(text.slice(index));
    if (channelMention) {
      elements.push({
        type: "channel",
        channel_id: channelMention[1],
        ...(Object.keys(style).length ? { style } : {}),
      });
      index += channelMention[0].length;
      continue;
    }

    const broadcastMention = /^<!(here|channel|everyone)>/.exec(text.slice(index));
    if (broadcastMention) {
      elements.push({
        type: "broadcast",
        range: broadcastMention[1],
        ...(Object.keys(style).length ? { style } : {}),
      });
      index += broadcastMention[0].length;
      continue;
    }

    const emoji = /^:([a-z0-9_+-]+):/i.exec(text.slice(index));
    if (emoji) {
      elements.push({
        type: "emoji",
        name: emoji[1],
        ...(Object.keys(style).length ? { style } : {}),
      });
      index += emoji[0].length;
      continue;
    }

    const styledDelimiters: Array<[string, RichTextStyle]> = [
      ["***", { bold: true, italic: true }],
      ["___", { bold: true, italic: true }],
      ["**", { bold: true }],
      ["__", { bold: true }],
      ["~~", { strike: true }],
      ["*", { italic: true }],
      ["_", { italic: true }],
    ];
    const styled = styledDelimiters.find(([delimiter]) => {
      const opensInsideWord = delimiter.includes("_")
        && /[\p{L}\p{N}]/u.test(text[index - 1] || "")
        && /[\p{L}\p{N}]/u.test(text[index + delimiter.length] || "");
      return text.startsWith(delimiter, index)
        && !/\s/.test(text[index + delimiter.length] || " ")
        && !opensInsideWord;
    });
    if (styled) {
      const [delimiter, addedStyle] = styled;
      const closing = findClosingDelimiter(text, delimiter, index + delimiter.length);
      if (closing >= 0) {
        elements.push(...parseInlineMarkdown(
          text.slice(index + delimiter.length, closing),
          { ...style, ...addedStyle },
        ));
        index = closing + delimiter.length;
        continue;
      }
    }

    appendText(elements, text[index]!, style);
    index += 1;
  }
  return elements;
}

function cellElements(text: string, header: boolean) {
  return parseInlineMarkdown(text, header ? { bold: true } : {});
}

function richTextCell(elements: RichTextElement[]) {
  elements = [...elements];
  if (elements.length === 0) elements.push({ type: "text", text: " " });
  return {
    type: "rich_text",
    elements: [{ type: "rich_text_section", elements }],
  };
}

function markdownTableRow(cells: string[]) {
  return `| ${cells.join(" | ")} |`;
}

function escapeFallbackText(text: string) {
  return Array.from(text, (character) => {
    if (character === "\n") return "<br>";
    return isMarkdownEscapable(character) ? `\\${character}` : character;
  }).join("");
}

function codeMarkdown(text: string) {
  const longestRun = Math.max(0, ...[...text.matchAll(/`+/g)].map((match) => match[0].length));
  const delimiter = "`".repeat(longestRun + 1);
  return `${delimiter}${text.replace(/\n/g, "<br>")}${delimiter}`;
}

function applyMarkdownStyle(source: string, style: RichTextStyle, codeText?: string) {
  let styled = style.code ? codeMarkdown(codeText ?? source) : source;
  if (style.strike) styled = `~~${styled}~~`;
  if (style.italic) styled = `*${styled}*`;
  if (style.bold) styled = `**${styled}**`;
  return styled;
}

function richTextElementMarkdown(element: RichTextElement, textOverride?: string) {
  const style = (element.style || {}) as RichTextStyle;
  if (element.type === "text") {
    const text = textOverride ?? String(element.text || "");
    return applyMarkdownStyle(escapeFallbackText(text), style, text);
  }
  if (element.type === "link") {
    const label = escapeFallbackText(textOverride ?? String(element.text || element.url || ""));
    const url = String(element.url || "").replace(/([\\()])/g, "\\$1");
    return applyMarkdownStyle(`[${label}](${url})`, style);
  }
  if (element.type === "user") return applyMarkdownStyle(`<@${String(element.user_id)}>`, style);
  if (element.type === "channel") return applyMarkdownStyle(`<#${String(element.channel_id)}>`, style);
  if (element.type === "broadcast") return applyMarkdownStyle(`<!${String(element.range)}>`, style);
  if (element.type === "emoji") return applyMarkdownStyle(`:${String(element.name)}:`, style);
  return "";
}

type SemanticCellFragment = {
  elements: RichTextElement[];
  source: string;
};

type SemanticTableRow = {
  cells: Array<Record<string, unknown>>;
  cellCharacterCount: number;
  source: string;
};

export type FinalReplyChunk = {
  blocks: Array<Record<string, unknown>>;
  text: string;
};

function elementCharacterCount(element: RichTextElement) {
  if (element.type === "text") return Array.from(String(element.text || "")).length;
  if (element.type === "link") {
    return Array.from(String(element.url || "")).length
      + Array.from(String(element.text || "")).length;
  }
  if (element.type === "emoji") return Array.from(`:${String(element.name)}:`).length;
  if (element.type === "user") return Array.from(String(element.user_id || "")).length;
  if (element.type === "channel") return Array.from(String(element.channel_id || "")).length;
  if (element.type === "broadcast") return Array.from(String(element.range || "")).length;
  return 0;
}

function splitTextElement(element: RichTextElement, limit: number): SemanticCellFragment[] {
  const text = String(element.text || element.url || "");
  if (!text) return [{ elements: [element], source: richTextElementMarkdown(element) }];
  const characters = Array.from(text);
  const fragments: SemanticCellFragment[] = [];
  let offset = 0;
  while (offset < characters.length) {
    let low = 1;
    let high = characters.length - offset;
    let count = 0;
    let source = "";
    while (low <= high) {
      const candidateCount = Math.floor((low + high) / 2);
      const candidateText = characters.slice(offset, offset + candidateCount).join("");
      const candidateSource = richTextElementMarkdown(element, candidateText);
      if (Array.from(candidateSource).length <= limit) {
        count = candidateCount;
        source = candidateSource;
        low = candidateCount + 1;
      } else {
        high = candidateCount - 1;
      }
    }
    if (count === 0) {
      count = 1;
      source = richTextElementMarkdown(element, characters[offset]!);
    }
    fragments.push({
      elements: [{ ...element, text: characters.slice(offset, offset + count).join("") }],
      source,
    });
    offset += count;
  }
  return fragments;
}

function splitSemanticCell(
  elements: RichTextElement[],
  fragmentLimit: number,
  atomicLimit: number,
): SemanticCellFragment[] {
  const elementFragments = elements.flatMap((element) => {
    const source = richTextElementMarkdown(element);
    if (Array.from(source).length <= fragmentLimit
      || (element.type === "link" && Array.from(source).length <= atomicLimit)) {
      return [{ elements: [element], source }];
    }
    if (element.type === "text" || element.type === "link") {
      return splitTextElement(element, fragmentLimit);
    }
    return [{ elements: [element], source }];
  });
  const fragments: SemanticCellFragment[] = [];
  for (const fragment of elementFragments) {
    const previous = fragments.at(-1);
    if (previous && Array.from(previous.source + fragment.source).length <= fragmentLimit) {
      previous.elements.push(...fragment.elements);
      previous.source += fragment.source;
    } else {
      fragments.push({ elements: [...fragment.elements], source: fragment.source });
    }
  }
  return fragments.length > 0 ? fragments : [{ elements: [], source: "" }];
}

function semanticRowFragments(rawCells: string[], columnCount: number, contentLimit: number, header: boolean) {
  const normalizedCells = [
    ...rawCells,
    ...Array.from({ length: Math.max(0, columnCount - rawCells.length) }, () => ""),
  ];
  const balancedCellLimit = Math.max(1, Math.floor(contentLimit / columnCount));
  const cellFragments = normalizedCells.map((cell) =>
    splitSemanticCell(cellElements(cell, header), balancedCellLimit, contentLimit));
  const fragmentCount = Math.max(...cellFragments.map((cell) => cell.length));
  const orderedFragments = Array.from({ length: fragmentCount }, (_, fragmentIndex) =>
    cellFragments.flatMap((cell, columnIndex) => cell[fragmentIndex]
      ? [{ columnIndex, fragment: cell[fragmentIndex]! }]
      : [])).flat();
  const rows: SemanticTableRow[] = [];
  let fragments = normalizedCells.map((): SemanticCellFragment => ({ elements: [], source: "" }));
  let sourceCharacterCount = 0;
  let cellCharacterCount = 0;

  const pushRow = () => {
    rows.push({
      cells: fragments.map((fragment) => richTextCell(fragment.elements)),
      cellCharacterCount,
      source: markdownTableRow(fragments.map((fragment) => fragment.source)),
    });
    fragments = normalizedCells.map((): SemanticCellFragment => ({ elements: [], source: "" }));
    sourceCharacterCount = 0;
    cellCharacterCount = 0;
  };

  for (const { columnIndex, fragment } of orderedFragments) {
    const fragmentSourceCharacters = Array.from(fragment.source).length;
    const fragmentCellCharacters = fragment.elements.reduce((total, element) =>
      total + elementCharacterCount(element), 0);
    if (sourceCharacterCount > 0
      && (sourceCharacterCount + fragmentSourceCharacters > contentLimit
        || cellCharacterCount + fragmentCellCharacters > MAX_TABLE_CHARACTERS)) pushRow();
    fragments[columnIndex]!.elements.push(...fragment.elements);
    fragments[columnIndex]!.source += fragment.source;
    sourceCharacterCount += fragmentSourceCharacters;
    cellCharacterCount += fragmentCellCharacters;
  }
  pushRow();
  return rows;
}

function tablePage(table: ParsedMarkdownTable, rows: SemanticTableRow[]): FinalReplyChunk {
  return {
    text: [rows[0]!.source, table.delimiterLine, ...rows.slice(1).map((row) => row.source)].join("\n"),
    blocks: [{
      type: "table",
      column_settings: table.columnSettings,
      rows: rows.map((row) => row.cells),
    }],
  };
}

function tablePageFits(table: ParsedMarkdownTable, rows: SemanticTableRow[], limit: number) {
  if (rows.length > MAX_TABLE_ROWS) return false;
  if (rows.reduce((total, row) => total + row.cellCharacterCount, 0) > MAX_TABLE_CHARACTERS) return false;
  return Array.from(tablePage(table, rows).text).length + 1 <= limit;
}

function preserveTableLineBoundaries(chunks: FinalReplyChunk[], sourceEndsWithNewline: boolean) {
  return chunks.map((chunk, index) => index < chunks.length - 1 || sourceEndsWithNewline
    ? { ...chunk, text: `${chunk.text}\n` }
    : chunk);
}

function nativeTableChunks(
  table: ParsedMarkdownTable,
  limit: number,
  sourceEndsWithNewline: boolean,
): FinalReplyChunk[] | null {
  const columnCount = table.rows[0]!.length;
  const rowSyntaxLength = Array.from(markdownTableRow(table.rows[0]!.map(() => ""))).length;
  const delimiterLength = Array.from(table.delimiterLine).length + 1;
  const maximumRowContent = Math.max(columnCount, limit - rowSyntaxLength - delimiterLength - 1);
  const headerRows = semanticRowFragments(table.rows[0]!, columnCount, maximumRowContent, true);
  if (headerRows.length === 1 && Array.from(table.headerLine).length <= limit - delimiterLength) {
    headerRows[0]!.source = table.headerLine;
  }
  const fullBodyRowGroups = table.bodyRows.map((row) =>
    semanticRowFragments(row, columnCount, maximumRowContent, false));
  const fullBodyRows = fullBodyRowGroups.flat();
  const repeatedHeaderCost = headerRows.length === 1 ? Array.from(headerRows[0]!.source).length + 1 : 0;
  const repeatedBodyContent = Math.max(columnCount, maximumRowContent - repeatedHeaderCost);
  const repeatedBodyRowGroups = headerRows.length === 1
    ? table.bodyRows.map((row) => semanticRowFragments(row, columnCount, repeatedBodyContent, false))
    : [];
  const bodyRows = headerRows.length === 1
    ? fullBodyRowGroups.flatMap((fullRows, index) => {
      const repeatedRows = repeatedBodyRowGroups[index]!;
      return repeatedRows.every((row) => tablePageFits(table, [headerRows[0]!, row], limit))
        ? repeatedRows
        : fullRows;
    })
    : fullBodyRows;
  if ([...headerRows, ...bodyRows].some((row) => !tablePageFits(table, [row], limit))) return null;

  if (headerRows.length !== 1) {
    const pages: FinalReplyChunk[] = [];
    let rows: SemanticTableRow[] = [];
    for (const row of [...headerRows, ...bodyRows]) {
      if (rows.length > 0 && !tablePageFits(table, [...rows, row], limit)) {
        pages.push(tablePage(table, rows));
        rows = [];
      }
      rows.push(row);
    }
    if (rows.length > 0) pages.push(tablePage(table, rows));
    return preserveTableLineBoundaries(pages, sourceEndsWithNewline);
  }

  const pages: FinalReplyChunk[] = [];
  const header = headerRows[0]!;
  let rows = [header];
  for (const row of bodyRows) {
    if (rows.length > 0 && tablePageFits(table, [...rows, row], limit)) {
      rows.push(row);
      continue;
    }
    if (rows.length > 0) {
      pages.push(tablePage(table, rows));
      rows = [];
    }
    if (tablePageFits(table, [header, row], limit)) {
      rows = [header, row];
    } else {
      pages.push(tablePage(table, [row]));
    }
  }
  if (rows.length > 0) pages.push(tablePage(table, rows));
  return preserveTableLineBoundaries(pages, sourceEndsWithNewline);
}

function markdownChunks(text: string, limit: number): FinalReplyChunk[] {
  if (!text) return [];
  return splitProgressMarkdown(text, limit).map((chunk) => ({
    text: chunk,
    blocks: [{ type: "markdown", text: chunk }],
  }));
}

function prependMarkdown(chunk: FinalReplyChunk, markdown: string) {
  if (!markdown) return chunk;
  return {
    text: markdown + chunk.text,
    blocks: [
      ...(markdown.trim() ? [{ type: "markdown", text: markdown }] : []),
      ...chunk.blocks,
    ],
  };
}

function appendMarkdown(chunk: FinalReplyChunk, markdown: string) {
  if (!markdown) return chunk;
  return {
    text: chunk.text + markdown,
    blocks: [
      ...chunk.blocks,
      ...(markdown.trim() ? [{ type: "markdown", text: markdown }] : []),
    ],
  };
}

function surroundChunks(
  chunks: FinalReplyChunk[],
  prefix: string,
  suffix: string,
  limit: number,
) {
  const surrounded = [...chunks];
  const preceding = markdownChunks(prefix, limit);
  const lastPrefix = preceding.at(-1);
  if (lastPrefix && Array.from(lastPrefix.text + surrounded[0]!.text).length <= limit) {
    surrounded[0] = prependMarkdown(surrounded[0]!, lastPrefix.text);
    preceding.pop();
  }

  const following = markdownChunks(suffix, limit);
  const firstSuffix = following[0];
  if (firstSuffix && Array.from(surrounded.at(-1)!.text + firstSuffix.text).length <= limit) {
    surrounded[surrounded.length - 1] = appendMarkdown(surrounded.at(-1)!, firstSuffix.text);
    following.shift();
  }
  return [...preceding, ...surrounded, ...following];
}

function lineOffsets(markdown: string) {
  const starts = [0];
  for (let index = 0; index < markdown.length; index += 1) {
    if (markdown[index] === "\n") starts.push(index + 1);
  }
  return starts;
}

export function finalReplyChunks(markdown: string, limit = 3_800): FinalReplyChunk[] {
  const tables = parseMarkdownTables(markdown);
  if (tables.length === 0) return markdown
    ? markdownChunks(markdown, limit)
    : [{ text: markdown, blocks: [{ type: "markdown", text: markdown }] }];

  const starts = lineOffsets(markdown);
  const chunks: FinalReplyChunk[] = [];
  for (const [tableIndex, table] of tables.entries()) {
    const nextTable = tables[tableIndex + 1];
    const tableStart = starts[table.startLine]!;
    const tableEnd = starts[table.endLine + 1] ?? markdown.length;
    const prefix = tableIndex === 0 ? markdown.slice(0, tableStart) : "";
    const tableSource = markdown.slice(tableStart, tableEnd);
    const suffixEnd = nextTable ? starts[nextTable.startLine]! : markdown.length;
    const suffix = markdown.slice(tableEnd, suffixEnd);
    const nativeChunks = table.hasNativeColumnShape
      ? nativeTableChunks(table, limit, tableSource.endsWith("\n"))
      : null;
    const tableChunks = nativeChunks ?? markdownChunks(tableSource, limit);
    chunks.push(...surroundChunks(tableChunks, prefix, suffix, limit));
  }
  return chunks;
}

export function blocksWithContinuation(chunk: FinalReplyChunk, label: string | null) {
  if (!label) return chunk.blocks;
  const suffix = `\n\n${label}`;
  const blocks = chunk.blocks.map((block) => ({ ...block }));
  const last = blocks.at(-1);
  if (last?.type === "markdown") last.text = `${String(last.text)}${suffix}`;
  else blocks.push({ type: "markdown", text: label });
  return blocks;
}
