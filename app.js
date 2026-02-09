"use strict";

const EMPTY_SENDER_KEY = "__EMPTY__";
const URL_REGEX = /https?:\/\/[^\s]+/gi;
const FILE_ATTACHED_REGEX = /^([^\n]+?)\s*\(file attached\)([\s\S]*)$/i;
const ATTACHED_TOKEN_REGEX = /<attached:\s*([^>]+)>/i;
const OMITTED_LINE_REGEX = /^<[^>]*omitted>$/i;
const OMITTED_CAPTURE_REGEX = /^<([^>]+?)\s+omitted>$/i;
const LEGACY_OMITTED_LINE_REGEX = /^(image|video|audio|gif|sticker|document)\s+omitted$/i;
const INVISIBLE_MARKS_REGEX = /[\u200c\u200d\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;
const ENABLE_BEST_EFFORT_OMITTED_MAPPING = false;

const state = {
  conversations: [],
  activeConversationId: null,
  selfSenderByConversation: new Map(),
  chatSearchQuery: "",
  messageSearchQuery: "",
  renderToken: 0,
  objectUrls: new Set(),
  busy: false,
};

let globalSequence = 0;
let dragDepth = 0;

const refs = {
  appShell: document.getElementById("appShell"),
  sidebar: document.getElementById("sidebar"),
  conversationList: document.getElementById("conversationList"),
  chatTitle: document.getElementById("chatTitle"),
  chatMeta: document.getElementById("chatMeta"),
  messageList: document.getElementById("messageList"),
  statusText: document.getElementById("statusText"),
  zipInput: document.getElementById("zipInput"),
  folderInput: document.getElementById("folderInput"),
  clearBtn: document.getElementById("clearBtn"),
  selfSelector: document.getElementById("selfSelector"),
  chatSearchInput: document.getElementById("chatSearchInput"),
  messageSearchInput: document.getElementById("messageSearchInput"),
  toggleSidebarBtn: document.getElementById("toggleSidebarBtn"),
  dropOverlay: document.getElementById("dropOverlay"),
};

function init() {
  refs.zipInput.addEventListener("change", async (event) => {
    const files = Array.from(event.target.files || []);
    refs.zipInput.value = "";
    if (files.length) {
      await loadZipFiles(files);
    }
  });

  refs.folderInput.addEventListener("change", async (event) => {
    const files = Array.from(event.target.files || []);
    refs.folderInput.value = "";
    if (files.length) {
      await loadFolderFiles(files);
    }
  });

  refs.clearBtn.addEventListener("click", () => {
    clearAllData();
  });

  refs.chatSearchInput.addEventListener("input", (event) => {
    state.chatSearchQuery = event.target.value.trim().toLowerCase();
    renderConversationList();
  });

  refs.messageSearchInput.addEventListener("input", (event) => {
    state.messageSearchQuery = event.target.value.trim().toLowerCase();
    renderMessages();
    updateChatMeta();
  });

  refs.selfSelector.addEventListener("change", (event) => {
    const conversation = getActiveConversation();
    if (!conversation) {
      return;
    }
    state.selfSenderByConversation.set(conversation.id, event.target.value);
    renderMessages();
  });

  refs.toggleSidebarBtn.addEventListener("click", () => {
    refs.appShell.classList.toggle("sidebar-open");
  });

  document.addEventListener("dragenter", (event) => {
    event.preventDefault();
    dragDepth += 1;
    refs.dropOverlay.classList.add("active");
  });

  document.addEventListener("dragover", (event) => {
    event.preventDefault();
  });

  document.addEventListener("dragleave", () => {
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) {
      refs.dropOverlay.classList.remove("active");
    }
  });

  document.addEventListener("drop", async (event) => {
    event.preventDefault();
    dragDepth = 0;
    refs.dropOverlay.classList.remove("active");

    const files = Array.from(event.dataTransfer?.files || []);
    if (!files.length) {
      return;
    }

    const zipFiles = files.filter((file) => isZipFile(file.name));
    if (zipFiles.length === files.length) {
      await loadZipFiles(zipFiles);
      return;
    }

    await loadFolderFiles(files);
  });

  renderConversationList();
  renderMessages();
}

async function loadZipFiles(files) {
  if (state.busy) {
    setStatus("Another import is running. Wait for it to finish.");
    return;
  }

  setBusy(true);
  try {
    setStatus(`Loading ${files.length} ZIP file(s)...`);
    const parsed = [];
    for (let index = 0; index < files.length; index += 1) {
      const file = files[index];
      setStatus(`Reading ZIP ${index + 1}/${files.length}: ${file.name}`);
      const fromFile = await parseZipFile(file);
      parsed.push(...fromFile);
    }

    ingestConversations(parsed);
    setStatus(`Loaded ${parsed.length} chat export(s) from ZIP.`);
  } catch (error) {
    console.error(error);
    setStatus(`Failed to load ZIP: ${String(error.message || error)}`);
  } finally {
    setBusy(false);
  }
}

async function loadFolderFiles(files) {
  if (state.busy) {
    setStatus("Another import is running. Wait for it to finish.");
    return;
  }

  setBusy(true);
  try {
    setStatus(`Loading ${files.length} file(s) from folder...`);
    const parsed = await parseFolderSelection(files);
    ingestConversations(parsed);
    setStatus(`Loaded ${parsed.length} chat export(s) from folder.`);
  } catch (error) {
    console.error(error);
    setStatus(`Failed to load folder: ${String(error.message || error)}`);
  } finally {
    setBusy(false);
  }
}

function ingestConversations(parsedConversations) {
  if (!parsedConversations.length) {
    setStatus("No valid WhatsApp chat exports found in selection.");
    return;
  }

  const combined = combineConversations([...state.conversations, ...parsedConversations]);
  state.conversations = combined;

  if (!state.activeConversationId || !state.conversations.some((item) => item.id === state.activeConversationId)) {
    state.activeConversationId = state.conversations[0]?.id || null;
  }

  for (const conversation of state.conversations) {
    if (!state.selfSenderByConversation.has(conversation.id)) {
      state.selfSenderByConversation.set(conversation.id, conversation.defaultSelfSenderKey || "");
    }
  }

  renderConversationList();
  renderChatHeader();
  renderMessages(true);
}

function combineConversations(conversations) {
  const grouped = new Map();

  for (const conversation of conversations) {
    if (!conversation || !conversation.messages?.length) {
      continue;
    }

    const key = normalizeConversationKey(conversation.title);
    if (!grouped.has(key)) {
      grouped.set(key, {
        id: key,
        title: conversation.title,
        messages: [],
      });
    }

    const target = grouped.get(key);
    target.messages.push(...conversation.messages);
  }

  const merged = Array.from(grouped.values()).map(finalizeConversation).filter(Boolean);
  merged.sort(compareConversations);
  return merged;
}

function finalizeConversation(conversation) {
  const seenSignatures = new Set();
  const dedupedMessages = [];

  for (const message of conversation.messages) {
    const signature = createMessageSignature(message);
    if (seenSignatures.has(signature)) {
      continue;
    }
    seenSignatures.add(signature);
    dedupedMessages.push(message);
  }

  dedupedMessages.sort(compareMessages);
  if (!dedupedMessages.length) {
    return null;
  }

  const participantsMap = new Map();
  for (const message of dedupedMessages) {
    if (message.isSystem) {
      continue;
    }
    const senderKey = message.senderKey || EMPTY_SENDER_KEY;
    const senderLabel = senderKey === EMPTY_SENDER_KEY ? "Unnamed Sender" : message.sender;
    const existing = participantsMap.get(senderKey) || { key: senderKey, label: senderLabel, count: 0 };
    existing.count += 1;
    participantsMap.set(senderKey, existing);
  }

  const participants = Array.from(participantsMap.values()).sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
  const defaultSelfSenderKey = pickDefaultSelfSenderKey(participants);

  const lastMessage = dedupedMessages[dedupedMessages.length - 1];
  return {
    id: conversation.id,
    title: conversation.title,
    messages: dedupedMessages,
    participants,
    defaultSelfSenderKey,
    lastTimestamp: lastMessage.timestamp || 0,
    lastSequence: lastMessage.sequence,
    preview: buildConversationPreview(lastMessage),
  };
}

function pickDefaultSelfSenderKey(participants) {
  if (!participants.length) {
    return "";
  }
  const unnamed = participants.find((item) => item.key === EMPTY_SENDER_KEY);
  if (unnamed) {
    return EMPTY_SENDER_KEY;
  }
  return participants[0].key;
}

function buildConversationPreview(lastMessage) {
  if (!lastMessage) {
    return "";
  }
  if (lastMessage.attachment?.displayName) {
    return `Attachment: ${lastMessage.attachment.displayName}`;
  }
  const trimmed = (lastMessage.text || "").replace(/\s+/g, " ").trim();
  return trimmed || "(empty)";
}

function compareConversations(a, b) {
  if (a.lastTimestamp !== b.lastTimestamp) {
    return (b.lastTimestamp || 0) - (a.lastTimestamp || 0);
  }
  return b.lastSequence - a.lastSequence;
}

function compareMessages(a, b) {
  if (a.timestamp && b.timestamp && a.timestamp !== b.timestamp) {
    return a.timestamp - b.timestamp;
  }
  return a.sequence - b.sequence;
}

function createMessageSignature(message) {
  const parts = [
    message.timestamp || message.rawDate || "",
    message.rawTime || "",
    message.senderKey || "",
    (message.text || "").trim(),
    message.attachment?.lookupKey || message.attachment?.displayName || "",
    message.isSystem ? "1" : "0",
  ];
  return parts.join("|\u241f|");
}

function normalizeConversationKey(title) {
  return title.trim().toLowerCase().replace(/\s+/g, " ");
}

async function parseZipFile(file) {
  const zip = await window.JSZip.loadAsync(file);
  const entries = Object.values(zip.files).filter((entry) => !entry.dir && !entry.name.startsWith("__MACOSX/"));
  const textEntries = entries.filter((entry) => isTextEntry(entry.name));

  if (!textEntries.length) {
    return [];
  }

  const parsedConversations = [];

  for (const textEntry of textEntries) {
    const textContent = await textEntry.async("string");
    const directory = getDirectoryPath(textEntry.name);
    const mediaEntries = entries.filter((entry) => !isTextEntry(entry.name) && isUnderDirectory(entry.name, directory));
    const mediaIndex = buildZipMediaIndex(file.name, mediaEntries);
    const title = deriveConversationTitle(textEntry.name);
    const conversation = parseConversationText(textContent, title, mediaIndex);
    if (conversation) {
      parsedConversations.push(conversation);
    }
  }

  return parsedConversations;
}

async function parseFolderSelection(files) {
  const records = files.map((file) => ({ file, path: getFilePath(file) }));
  const textRecords = records.filter((record) => isTextEntry(record.path));
  if (!textRecords.length) {
    return [];
  }

  const parsedConversations = [];

  for (let index = 0; index < textRecords.length; index += 1) {
    const textRecord = textRecords[index];
    setStatus(`Parsing text ${index + 1}/${textRecords.length}: ${textRecord.path}`);
    const textContent = await textRecord.file.text();
    const directory = getDirectoryPath(textRecord.path);
    const mediaRecords = records.filter((record) => !isTextEntry(record.path) && isUnderDirectory(record.path, directory));
    const mediaIndex = buildFolderMediaIndex(mediaRecords);
    const title = deriveConversationTitle(textRecord.path);
    const conversation = parseConversationText(textContent, title, mediaIndex);
    if (conversation) {
      parsedConversations.push(conversation);
    }
  }

  return parsedConversations;
}

function parseConversationText(textContent, title, mediaIndex) {
  const normalized = textContent.replace(/^\ufeff/, "");
  const lines = normalized.split(/\r?\n/);
  const rawMessages = [];
  let current = null;

  for (const line of lines) {
    const start = parseMessageStart(line);
    if (start) {
      if (current) {
        rawMessages.push(current);
      }
      current = {
        rawDate: start.datePart,
        rawTime: start.timePart,
        rest: start.rest,
        body: start.rest,
      };
      continue;
    }

    if (!current) {
      continue;
    }

    current.body += `\n${line}`;
  }

  if (current) {
    rawMessages.push(current);
  }

  if (!rawMessages.length) {
    return null;
  }

  const dateOrder = inferDateOrder(rawMessages);
  const messages = rawMessages.map((rawMessage) => hydrateMessage(rawMessage, dateOrder, mediaIndex)).filter(Boolean);

  if (!messages.length) {
    return null;
  }

  return {
    id: normalizeConversationKey(title),
    title,
    messages,
  };
}

function parseMessageStart(line) {
  const normalizedLine = line.replace(/\u202f/g, " ");

  const plainMatch = normalizedLine.match(/^(\d{1,2}\/\d{1,2}\/\d{2,4}),\s(.+?)\s-\s([\s\S]*)$/u);
  if (plainMatch) {
    return {
      datePart: plainMatch[1],
      timePart: plainMatch[2],
      rest: plainMatch[3],
    };
  }

  const bracketMatch = normalizedLine.match(/^\[(\d{1,2}\/\d{1,2}\/\d{2,4}),\s(.+?)\]\s([\s\S]*)$/u);
  if (bracketMatch) {
    return {
      datePart: bracketMatch[1],
      timePart: bracketMatch[2],
      rest: bracketMatch[3],
    };
  }

  return null;
}

function inferDateOrder(rawMessages) {
  let dayFirstVotes = 0;
  let monthFirstVotes = 0;

  for (const message of rawMessages.slice(0, 300)) {
    const parts = (message.rawDate || "").split("/").map((part) => Number.parseInt(part, 10));
    if (parts.length !== 3 || Number.isNaN(parts[0]) || Number.isNaN(parts[1])) {
      continue;
    }

    if (parts[0] > 12 && parts[1] <= 12) {
      dayFirstVotes += 1;
    } else if (parts[1] > 12 && parts[0] <= 12) {
      monthFirstVotes += 1;
    }
  }

  return monthFirstVotes > dayFirstVotes ? "MDY" : "DMY";
}

function hydrateMessage(rawMessage, dateOrder, mediaIndex) {
  const split = splitSenderAndText(rawMessage.body);
  const senderRaw = split.sender;
  const textRaw = split.text;
  const isSystem = split.isSystem;

  const parsedDate = parseDateTime(rawMessage.rawDate, rawMessage.rawTime, dateOrder);
  const attachmentInfo = extractAttachmentInfo(textRaw);
  const replyInfo = parseReplyContext(attachmentInfo.textWithoutAttachment);
  const messageText = replyInfo ? replyInfo.bodyText : attachmentInfo.textWithoutAttachment;

  let attachment = null;
  if (attachmentInfo.fileName) {
    const mediaRecord = resolveMediaRecord(mediaIndex, attachmentInfo.fileName);
    attachment = mediaRecord
      ? {
          displayName: mediaRecord.displayName,
          kind: mediaRecord.kind,
          mimeType: mediaRecord.mimeType,
          lookupKey: mediaRecord.lookupKey,
          getObjectUrl: mediaRecord.getObjectUrl,
          missing: false,
        }
      : {
          displayName: attachmentInfo.fileName,
          kind: "document",
          mimeType: "application/octet-stream",
          lookupKey: normalizeFileKey(attachmentInfo.fileName),
          getObjectUrl: null,
        missing: true,
      };
  } else if (attachmentInfo.omitted) {
    if (ENABLE_BEST_EFFORT_OMITTED_MAPPING) {
      const omittedRecord = resolveOmittedMediaRecord(mediaIndex, attachmentInfo.omittedKind);
      if (omittedRecord) {
        attachment = {
          displayName: omittedRecord.displayName,
          kind: omittedRecord.kind,
          mimeType: omittedRecord.mimeType,
          lookupKey: omittedRecord.lookupKey,
          getObjectUrl: omittedRecord.getObjectUrl,
          missing: false,
        };
      }
    }

    if (!attachment) {
      attachment = {
        displayName: "Media omitted",
        kind: "missing",
        mimeType: "",
        lookupKey: "omitted",
        getObjectUrl: null,
        missing: true,
      };
    }
  }

  const senderKey = isSystem ? "" : normalizeSenderKey(senderRaw);
  const sender = isSystem ? "" : senderLabelFromKey(senderKey, senderRaw);

  const message = {
    id: `${rawMessage.rawDate}-${rawMessage.rawTime}-${globalSequence}`,
    sequence: globalSequence,
    rawDate: rawMessage.rawDate,
    rawTime: rawMessage.rawTime,
    timestamp: parsedDate ? parsedDate.getTime() : null,
    formattedTime: formatMessageTime(parsedDate, rawMessage.rawTime),
    formattedDay: formatMessageDay(parsedDate, rawMessage.rawDate),
    sender,
    senderKey,
    isSystem,
    text: messageText,
    replyContext: replyInfo ? replyInfo.context : null,
    attachment,
    searchIndex: buildSearchIndex(
      sender,
      messageText,
      rawMessage.rawDate,
      rawMessage.rawTime,
      attachment?.displayName || "",
      replyInfo?.context?.targetName || "",
      replyInfo?.context?.quotedText || ""
    ),
  };

  globalSequence += 1;
  return message;
}

function normalizeSenderKey(senderRaw) {
  const cleaned = cleanupInvisibleMarks(senderRaw || "").trim();
  if (!cleaned) {
    return EMPTY_SENDER_KEY;
  }
  return cleaned;
}

function senderLabelFromKey(senderKey, senderRaw) {
  if (senderKey === EMPTY_SENDER_KEY) {
    return "Unnamed Sender";
  }
  return cleanupInvisibleMarks(senderRaw || "").trim() || "Unknown";
}

function splitSenderAndText(body) {
  const separatorIndex = body.indexOf(": ");
  if (separatorIndex === -1) {
    return {
      sender: "",
      text: body,
      isSystem: true,
    };
  }

  const candidateSender = body.slice(0, separatorIndex);
  const remainder = body.slice(separatorIndex + 2);
  const cleanedCandidate = cleanupInvisibleMarks(candidateSender).trim();

  if (cleanedCandidate.length > 80) {
    return {
      sender: "",
      text: body,
      isSystem: true,
    };
  }

  return {
    sender: cleanedCandidate,
    text: remainder,
    isSystem: false,
  };
}

function parseDateTime(datePart, timePart, dateOrder) {
  const dateParts = datePart.split("/").map((item) => Number.parseInt(item, 10));
  if (dateParts.length !== 3 || dateParts.some(Number.isNaN)) {
    return null;
  }

  let day;
  let month;
  let year;

  if (dateOrder === "MDY") {
    [month, day, year] = dateParts;
  } else {
    [day, month, year] = dateParts;
  }

  if (year < 100) {
    year += 2000;
  }

  const cleanedTime = cleanupInvisibleMarks(timePart).replace(/\u202f/g, " ").trim().toLowerCase();
  const timeMatch = cleanedTime.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(am|pm)?$/i);
  if (!timeMatch) {
    return null;
  }

  let hour = Number.parseInt(timeMatch[1], 10);
  const minute = Number.parseInt(timeMatch[2], 10);
  const second = timeMatch[3] ? Number.parseInt(timeMatch[3], 10) : 0;
  const meridiem = timeMatch[4] ? timeMatch[4].toLowerCase() : null;

  if (meridiem === "pm" && hour !== 12) {
    hour += 12;
  } else if (meridiem === "am" && hour === 12) {
    hour = 0;
  }

  const result = new Date(year, month - 1, day, hour, minute, second);
  return Number.isNaN(result.getTime()) ? null : result;
}

function formatMessageTime(parsedDate, rawTime) {
  if (!parsedDate) {
    return cleanupInvisibleMarks(rawTime || "");
  }
  return parsedDate.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatMessageDay(parsedDate, rawDate) {
  if (!parsedDate) {
    return rawDate;
  }
  return parsedDate.toLocaleDateString([], {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function extractAttachmentInfo(text) {
  const cleanedText = cleanupInvisibleMarks(text || "").trimEnd();

  const fileAttachedMatch = cleanedText.match(FILE_ATTACHED_REGEX);
  if (fileAttachedMatch) {
    const fileName = cleanupInvisibleMarks(fileAttachedMatch[1] || "").trim();
    const rest = (fileAttachedMatch[2] || "").trim();
    return {
      fileName,
      textWithoutAttachment: rest,
      omitted: false,
    };
  }

  const attachedTokenMatch = cleanedText.match(ATTACHED_TOKEN_REGEX);
  if (attachedTokenMatch) {
    const fileName = cleanupInvisibleMarks(attachedTokenMatch[1] || "").trim();
    const textWithoutAttachment = cleanedText.replace(ATTACHED_TOKEN_REGEX, "").trim();
    return {
      fileName,
      textWithoutAttachment,
      omitted: false,
    };
  }

  const textLines = cleanedText.split("\n");
  const firstLine = (textLines[0] || "").trim();
  const omittedCapture = firstLine.match(OMITTED_CAPTURE_REGEX);
  const legacyCapture = firstLine.match(LEGACY_OMITTED_LINE_REGEX);
  if (OMITTED_LINE_REGEX.test(firstLine) || legacyCapture) {
    const caption = textLines.slice(1).join("\n").trim();
    const omittedKindRaw = omittedCapture ? omittedCapture[1] : legacyCapture ? legacyCapture[1] : "";
    return {
      fileName: "",
      textWithoutAttachment: caption,
      omitted: true,
      omittedKind: normalizeOmittedKind(omittedKindRaw),
    };
  }

  return {
    fileName: "",
    textWithoutAttachment: cleanedText.trim(),
    omitted: false,
    omittedKind: "",
  };
}

function parseReplyContext(text) {
  const lines = String(text || "").split("\n");
  if (lines.length < 2) {
    return null;
  }

  const firstLine = cleanupInvisibleMarks(lines[0]).trim();
  if (!firstLine) {
    return null;
  }

  const patterns = [
    /^You replied to\s+(.+)$/i,
    /^(.+?) replied to you$/i,
    /^(.+?) replied to\s+(.+)$/i,
    /^Replying to\s+(.+)$/i,
  ];

  let targetName = "";
  for (const pattern of patterns) {
    const match = firstLine.match(pattern);
    if (!match) {
      continue;
    }
    targetName = cleanupInvisibleMarks(match[match.length - 1]).trim();
    break;
  }

  if (!targetName) {
    return null;
  }

  const quotedCandidate = cleanupInvisibleMarks(lines[1] || "").trim();
  const quotedText = quotedCandidate.replace(/^["“]|["”]$/g, "").trim();
  const bodyText = lines.slice(2).join("\n").trim();

  return {
    context: {
      targetName,
      quotedText,
    },
    bodyText,
  };
}

function buildSearchIndex(sender, text, rawDate, rawTime, attachmentLabel, replyTarget, replyQuotedText) {
  return [sender, text, rawDate, rawTime, attachmentLabel, replyTarget, replyQuotedText].join(" ").toLowerCase();
}

function buildZipMediaIndex(zipLabel, mediaEntries) {
  const exactMap = new Map();
  const normalizedMap = new Map();
  const allRecords = [];

  for (const entry of mediaEntries) {
    const displayName = fileBaseName(entry.name);
    const normalizedKey = normalizeFileKey(displayName);
    const lowerDisplayName = displayName.toLowerCase();
    const kind = detectMediaKind(displayName);
    const mimeType = guessMimeType(displayName, kind);

    let objectUrl = "";
    let pendingUrlPromise = null;

    const record = {
      displayName,
      lookupKey: normalizedKey,
      kind,
      mimeType,
      getObjectUrl: async () => {
        if (objectUrl) {
          return objectUrl;
        }
        if (!pendingUrlPromise) {
          pendingUrlPromise = entry.async("blob").then((blob) => {
            objectUrl = URL.createObjectURL(blob);
            state.objectUrls.add(objectUrl);
            return objectUrl;
          });
        }
        return pendingUrlPromise;
      },
      source: zipLabel,
      usedCount: 0,
    };

    pushMapItem(exactMap, lowerDisplayName, record);
    pushMapItem(normalizedMap, normalizedKey, record);
    allRecords.push(record);
  }

  allRecords.sort((a, b) => a.displayName.localeCompare(b.displayName));
  return { exactMap, normalizedMap, allRecords };
}

function buildFolderMediaIndex(mediaRecords) {
  const exactMap = new Map();
  const normalizedMap = new Map();
  const allRecords = [];

  for (const mediaRecord of mediaRecords) {
    const displayName = fileBaseName(mediaRecord.path);
    const normalizedKey = normalizeFileKey(displayName);
    const lowerDisplayName = displayName.toLowerCase();
    const kind = detectMediaKind(displayName);
    const mimeType = mediaRecord.file.type || guessMimeType(displayName, kind);

    let objectUrl = "";

    const record = {
      displayName,
      lookupKey: normalizedKey,
      kind,
      mimeType,
      getObjectUrl: async () => {
        if (!objectUrl) {
          objectUrl = URL.createObjectURL(mediaRecord.file);
          state.objectUrls.add(objectUrl);
        }
        return objectUrl;
      },
      source: mediaRecord.path,
      usedCount: 0,
    };

    pushMapItem(exactMap, lowerDisplayName, record);
    pushMapItem(normalizedMap, normalizedKey, record);
    allRecords.push(record);
  }

  allRecords.sort((a, b) => a.displayName.localeCompare(b.displayName));
  return { exactMap, normalizedMap, allRecords };
}

function resolveMediaRecord(mediaIndex, requestedName) {
  const cleanName = cleanupInvisibleMarks(requestedName || "").trim();
  if (!cleanName) {
    return null;
  }

  const exactKey = fileBaseName(cleanName).toLowerCase();
  const normalizedKey = normalizeFileKey(cleanName);

  const exactCandidates = mediaIndex.exactMap.get(exactKey);
  if (exactCandidates?.length) {
    return pickLeastUsedRecord(exactCandidates);
  }

  const normalizedCandidates = mediaIndex.normalizedMap.get(normalizedKey);
  if (normalizedCandidates?.length) {
    return pickLeastUsedRecord(normalizedCandidates);
  }

  for (const [key, records] of mediaIndex.normalizedMap.entries()) {
    if (!records.length) {
      continue;
    }
    if (key.endsWith(normalizedKey) || normalizedKey.endsWith(key)) {
      return pickLeastUsedRecord(records);
    }
  }

  return null;
}

function pickLeastUsedRecord(records) {
  let best = records[0];
  for (const record of records) {
    if (record.usedCount < best.usedCount) {
      best = record;
    }
  }
  best.usedCount += 1;
  return best;
}

function resolveOmittedMediaRecord(mediaIndex, omittedKind) {
  const kindHint = normalizeOmittedKind(omittedKind);
  const records = mediaIndex.allRecords || [];
  let fallback = null;

  for (const record of records) {
    if (record.usedCount > 0) {
      continue;
    }

    if (!fallback) {
      fallback = record;
    }

    if (!kindHint || kindHint === "media") {
      return pickLeastUsedRecord([record]);
    }

    if (record.kind === kindHint) {
      return pickLeastUsedRecord([record]);
    }

    if (kindHint === "gif" && (record.kind === "gif" || record.kind === "video")) {
      return pickLeastUsedRecord([record]);
    }
  }

  return fallback ? pickLeastUsedRecord([fallback]) : null;
}

function pushMapItem(map, key, value) {
  if (!map.has(key)) {
    map.set(key, []);
  }
  map.get(key).push(value);
}

function detectMediaKind(fileName) {
  const extension = fileExtension(fileName);

  if (/^gif-/i.test(fileName)) {
    return "gif";
  }
  if (["jpg", "jpeg", "png", "gif", "heic", "bmp"].includes(extension)) {
    return extension === "gif" ? "gif" : "image";
  }
  if (extension === "webp" && /^stk-/i.test(fileName)) {
    return "sticker";
  }
  if (["mp4", "mov", "webm", "mkv", "3gp"].includes(extension)) {
    return "video";
  }
  if (["opus", "ogg", "aac", "m4a", "mp3", "wav"].includes(extension)) {
    return "audio";
  }
  if (extension === "webp") {
    return "image";
  }
  return "document";
}

function guessMimeType(fileName, kind) {
  const extension = fileExtension(fileName);
  const staticMap = {
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    png: "image/png",
    gif: "image/gif",
    webp: "image/webp",
    heic: "image/heic",
    bmp: "image/bmp",
    mp4: "video/mp4",
    mov: "video/quicktime",
    webm: "video/webm",
    mkv: "video/x-matroska",
    "3gp": "video/3gpp",
    opus: "audio/ogg",
    ogg: "audio/ogg",
    aac: "audio/aac",
    m4a: "audio/mp4",
    mp3: "audio/mpeg",
    wav: "audio/wav",
    vcf: "text/vcard",
    pdf: "application/pdf",
    txt: "text/plain",
  };

  if (staticMap[extension]) {
    if (kind === "gif" && extension === "mp4") {
      return "video/mp4";
    }
    return staticMap[extension];
  }

  if (kind === "image" || kind === "sticker") {
    return "image/*";
  }
  if (kind === "video") {
    return "video/*";
  }
  if (kind === "gif") {
    return "image/gif";
  }
  if (kind === "audio") {
    return "audio/*";
  }
  return "application/octet-stream";
}

function normalizeOmittedKind(kindRaw) {
  const value = cleanupInvisibleMarks(kindRaw || "").trim().toLowerCase();
  if (!value || value === "media") {
    return "media";
  }
  if (value.includes("image")) {
    return "image";
  }
  if (value.includes("video")) {
    return "video";
  }
  if (value.includes("audio") || value.includes("voice")) {
    return "audio";
  }
  if (value.includes("sticker")) {
    return "sticker";
  }
  if (value.includes("gif")) {
    return "gif";
  }
  if (value.includes("document") || value.includes("file")) {
    return "document";
  }
  return "media";
}

function normalizeFileKey(fileName) {
  return cleanupInvisibleMarks(fileBaseName(fileName))
    .normalize("NFKD")
    .replace(/[^\w.\-]+/g, "")
    .toLowerCase();
}

function renderConversationList() {
  const list = refs.conversationList;
  list.innerHTML = "";

  let conversations = state.conversations;
  if (state.chatSearchQuery) {
    conversations = conversations.filter((conversation) => conversation.title.toLowerCase().includes(state.chatSearchQuery));
  }

  if (!conversations.length) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = "No chats loaded. Use Load ZIP(s), Load Folder, or drag-and-drop exports.";
    list.append(empty);
    renderChatHeader();
    return;
  }

  const fragment = document.createDocumentFragment();

  for (const conversation of conversations) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `conversation-item${conversation.id === state.activeConversationId ? " active" : ""}`;

    const left = document.createElement("div");
    const title = document.createElement("h3");
    title.textContent = conversation.title;
    left.append(title);

    const preview = document.createElement("p");
    preview.textContent = conversation.preview || "(empty)";
    left.append(preview);

    const right = document.createElement("time");
    right.textContent = formatConversationTimestamp(conversation.lastTimestamp);

    button.append(left, right);
    button.addEventListener("click", () => {
      state.activeConversationId = conversation.id;
      renderConversationList();
      renderChatHeader();
      renderMessages(true);
      refs.appShell.classList.remove("sidebar-open");
    });

    fragment.append(button);
  }

  list.append(fragment);
  renderChatHeader();
}

function renderChatHeader() {
  const conversation = getActiveConversation();

  if (!conversation) {
    refs.chatTitle.textContent = "No chat loaded";
    refs.chatMeta.textContent = "Load one or more exports to start";
    refs.selfSelector.innerHTML = "";
    return;
  }

  refs.chatTitle.textContent = conversation.title;
  updateChatMeta();
  populateSelfSelector(conversation);
}

function updateChatMeta() {
  const conversation = getActiveConversation();
  if (!conversation) {
    return;
  }

  const visibleCount = getVisibleMessages(conversation).length;
  const filteredText = state.messageSearchQuery ? ` | showing ${visibleCount}` : "";
  refs.chatMeta.textContent = `${conversation.messages.length} messages | ${conversation.participants.length} participant(s)${filteredText}`;
}

function populateSelfSelector(conversation) {
  const selected = state.selfSenderByConversation.get(conversation.id) || "";
  const selector = refs.selfSelector;
  selector.innerHTML = "";

  const noneOption = document.createElement("option");
  noneOption.value = "";
  noneOption.textContent = "(Not set)";
  selector.append(noneOption);

  for (const participant of conversation.participants) {
    const option = document.createElement("option");
    option.value = participant.key;
    option.textContent = participant.key === EMPTY_SENDER_KEY ? "Unnamed Sender" : participant.label;
    selector.append(option);
  }

  selector.value = selected;
}

function renderMessages(scrollToBottom = false) {
  const conversation = getActiveConversation();
  const list = refs.messageList;
  list.innerHTML = "";

  if (!conversation) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = "No chat selected.";
    list.append(empty);
    return;
  }

  const messages = getVisibleMessages(conversation);
  if (!messages.length) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = "No messages match your search.";
    list.append(empty);
    return;
  }

  const selfSenderKey = state.selfSenderByConversation.get(conversation.id) || "";
  const fragment = document.createDocumentFragment();

  const renderToken = ++state.renderToken;
  let previousDay = "";

  for (const message of messages) {
    if (message.formattedDay !== previousDay) {
      previousDay = message.formattedDay;
      const divider = document.createElement("div");
      divider.className = "date-divider";
      const span = document.createElement("span");
      span.textContent = message.formattedDay;
      divider.append(span);
      fragment.append(divider);
    }

    const row = document.createElement("div");
    if (message.isSystem) {
      row.className = "message-row system";
    } else {
      const directionClass = selfSenderKey && message.senderKey === selfSenderKey ? "outgoing" : "incoming";
      row.className = `message-row ${directionClass}`;
    }

    const bubble = document.createElement("article");
    bubble.className = "message-bubble";

    if (!message.isSystem && row.classList.contains("incoming")) {
      const senderLabel = document.createElement("div");
      senderLabel.className = "sender-label";
      senderLabel.textContent = message.sender;
      bubble.append(senderLabel);
    }

    if (message.attachment) {
      const attachmentContainer = document.createElement("div");
      attachmentContainer.className = "attachment";
      bubble.append(attachmentContainer);
      void hydrateAttachmentNode(attachmentContainer, message.attachment, renderToken);
    }

    if (message.replyContext) {
      const replyNode = document.createElement("div");
      replyNode.className = "reply-snippet";

      const target = document.createElement("div");
      target.className = "reply-target";
      target.textContent = message.replyContext.targetName || "Reply";
      replyNode.append(target);

      if (message.replyContext.quotedText) {
        const quote = document.createElement("div");
        quote.className = "reply-quote";
        quote.textContent = message.replyContext.quotedText;
        replyNode.append(quote);
      }

      bubble.append(replyNode);
    }

    if (message.text) {
      const textNode = document.createElement("p");
      textNode.className = "message-text";
      appendTextWithLinks(textNode, message.text);
      bubble.append(textNode);
    }

    const metaNode = document.createElement("div");
    metaNode.className = "message-meta";
    const timeNode = document.createElement("time");
    timeNode.className = "message-time";
    timeNode.textContent = message.formattedTime;
    metaNode.append(timeNode);
    bubble.append(metaNode);

    row.append(bubble);
    fragment.append(row);
  }

  list.append(fragment);

  if (scrollToBottom) {
    list.scrollTop = list.scrollHeight;
  }
}

async function hydrateAttachmentNode(container, attachment, token) {
  if (attachment.missing || !attachment.getObjectUrl) {
    container.classList.add("attachment-note");
    container.textContent = `Missing media: ${attachment.displayName}`;
    return;
  }

  try {
    const objectUrl = await attachment.getObjectUrl();
    if (token !== state.renderToken) {
      return;
    }

    container.innerHTML = "";

    if (attachment.kind === "image" || attachment.kind === "sticker") {
      if (attachment.kind === "sticker") {
        container.classList.add("sticker");
      }
      const image = document.createElement("img");
      image.src = objectUrl;
      image.alt = attachment.displayName;
      image.loading = "lazy";
      container.append(image);
      return;
    }

    if (attachment.kind === "gif") {
      if (attachment.mimeType.startsWith("video/")) {
        const gifVideo = document.createElement("video");
        gifVideo.src = objectUrl;
        gifVideo.autoplay = true;
        gifVideo.loop = true;
        gifVideo.muted = true;
        gifVideo.playsInline = true;
        gifVideo.controls = false;
        gifVideo.preload = "metadata";
        container.append(gifVideo);
        return;
      }

      const gifImage = document.createElement("img");
      gifImage.src = objectUrl;
      gifImage.alt = attachment.displayName;
      gifImage.loading = "lazy";
      container.append(gifImage);
      return;
    }

    if (attachment.kind === "video") {
      const video = document.createElement("video");
      video.src = objectUrl;
      video.controls = true;
      video.preload = "metadata";
      container.append(video);
      return;
    }

    if (attachment.kind === "audio") {
      const audio = document.createElement("audio");
      audio.src = objectUrl;
      audio.controls = true;
      audio.preload = "metadata";
      container.append(audio);
      return;
    }

    const link = document.createElement("a");
    link.className = "attachment-file";
    link.href = objectUrl;
    link.download = attachment.displayName;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.textContent = `Open ${attachment.displayName}`;
    container.append(link);
  } catch (error) {
    console.error(error);
    container.classList.add("attachment-note");
    container.textContent = `Failed to render media: ${attachment.displayName}`;
  }
}

function appendTextWithLinks(parent, text) {
  const matches = text.match(URL_REGEX);
  if (!matches) {
    parent.textContent = text;
    return;
  }

  let currentIndex = 0;
  URL_REGEX.lastIndex = 0;
  let match = URL_REGEX.exec(text);

  while (match) {
    const start = match.index;
    const rawUrl = match[0];

    if (start > currentIndex) {
      parent.append(document.createTextNode(text.slice(currentIndex, start)));
    }

    const anchor = document.createElement("a");
    anchor.href = rawUrl;
    anchor.target = "_blank";
    anchor.rel = "noopener noreferrer";
    anchor.textContent = rawUrl;
    parent.append(anchor);

    currentIndex = start + rawUrl.length;
    match = URL_REGEX.exec(text);
  }

  if (currentIndex < text.length) {
    parent.append(document.createTextNode(text.slice(currentIndex)));
  }

  URL_REGEX.lastIndex = 0;
}

function getVisibleMessages(conversation) {
  if (!state.messageSearchQuery) {
    return conversation.messages;
  }

  return conversation.messages.filter((message) => message.searchIndex.includes(state.messageSearchQuery));
}

function getActiveConversation() {
  return state.conversations.find((conversation) => conversation.id === state.activeConversationId) || null;
}

function clearAllData() {
  revokeAllObjectUrls();
  state.conversations = [];
  state.activeConversationId = null;
  state.selfSenderByConversation.clear();
  state.chatSearchQuery = "";
  state.messageSearchQuery = "";

  refs.chatSearchInput.value = "";
  refs.messageSearchInput.value = "";

  renderConversationList();
  renderMessages();
  refs.chatTitle.textContent = "No chat loaded";
  refs.chatMeta.textContent = "Load one or more exports to start";
  refs.selfSelector.innerHTML = "";
  setStatus("Cleared all loaded chat data.");
}

function revokeAllObjectUrls() {
  for (const url of state.objectUrls) {
    URL.revokeObjectURL(url);
  }
  state.objectUrls.clear();
}

function setBusy(busy) {
  state.busy = busy;
  refs.zipInput.disabled = busy;
  refs.folderInput.disabled = busy;
  refs.clearBtn.disabled = busy;
}

function setStatus(message) {
  refs.statusText.textContent = message;
}

function fileExtension(fileName) {
  const base = fileBaseName(fileName);
  const dotIndex = base.lastIndexOf(".");
  if (dotIndex === -1 || dotIndex === base.length - 1) {
    return "";
  }
  return base.slice(dotIndex + 1).toLowerCase();
}

function fileBaseName(path) {
  const normalized = path.replace(/\\/g, "/");
  const lastSlash = normalized.lastIndexOf("/");
  if (lastSlash === -1) {
    return normalized;
  }
  return normalized.slice(lastSlash + 1);
}

function getDirectoryPath(path) {
  const normalized = path.replace(/\\/g, "/");
  const lastSlash = normalized.lastIndexOf("/");
  if (lastSlash === -1) {
    return "";
  }
  return normalized.slice(0, lastSlash);
}

function isUnderDirectory(path, directory) {
  if (!directory) {
    return !path.includes("/");
  }
  return path === directory || path.startsWith(`${directory}/`);
}

function deriveConversationTitle(path) {
  const base = fileBaseName(path).replace(/\.txt$/i, "");
  const cleaned = cleanupInvisibleMarks(base).trim();

  const match = cleaned.match(/^WhatsApp Chat with\s+(.+)$/i);
  if (match) {
    return match[1].trim();
  }

  if (cleaned === "_chat") {
    const directory = getDirectoryPath(path);
    if (directory) {
      return fileBaseName(directory);
    }
  }

  return cleaned || "Untitled Chat";
}

function getFilePath(file) {
  if (file.webkitRelativePath) {
    return file.webkitRelativePath;
  }
  return file.name;
}

function isTextEntry(path) {
  return /\.txt$/i.test(path);
}

function isZipFile(name) {
  return /\.zip$/i.test(name);
}

function cleanupInvisibleMarks(value) {
  return String(value || "").replace(INVISIBLE_MARKS_REGEX, "");
}

function formatConversationTimestamp(timestamp) {
  if (!timestamp) {
    return "";
  }
  const date = new Date(timestamp);
  return date.toLocaleDateString([], {
    month: "short",
    day: "numeric",
  });
}

window.addEventListener("beforeunload", () => {
  revokeAllObjectUrls();
});

init();
