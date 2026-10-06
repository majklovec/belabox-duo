/**
 * Generuje URL pro živé vysílání na základě zadaného ID
 */
function generateLiveUrl(id) {
  if (id.channelId) {
    return `https://www.youtube.com/channel/${id.channelId}/live`;
  } else if (id.liveId) {
    return `https://www.youtube.com/watch?v=${id.liveId}`;
  } else if (id.handle) {
    let handle = id.handle;
    if (!handle.startsWith("@")) {
      handle = "@" + handle;
    }
    return `https://www.youtube.com/${handle}/live`;
  }
  return "";
}

/**
 * Načte HTML stránku streamu a vytáhne z ní potřebné parametry pro Innertube API
 */
async function fetchLivePage(id) {
  const url = generateLiveUrl(id);
  if (!url) {
    throw new TypeError("Identifikátor streamu nebyl nalezen");
  }

  const res = await fetch(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    },
  });
  const html = await res.text();
  return getOptionsFromLivePage(html);
}

/**
 * Regex parsování inicializačních dat z HTML stránky YouTube
 */
function getOptionsFromLivePage(data) {
  let liveId;
  const idResult = data.match(
    /<link rel="canonical" href="https:\/\/www.youtube.com\/watch\?v=(.+?)">/,
  );
  if (idResult) {
    liveId = idResult[1];
  } else {
    throw new Error("Živý stream nebyl nalezen");
  }

  const replayResult = data.match(/['"]isReplay['"]:\s*(true)/);
  if (replayResult) {
    throw new Error(`${liveId} - stream již skončil (záznam)`);
  }

  let apiKey;
  const keyResult = data.match(/['"]INNERTUBE_API_KEY['"]:\s*['"](.+?)['"]/);
  if (keyResult) {
    apiKey = keyResult[1];
  } else {
    throw new Error("API klíč (INNERTUBE_API_KEY) nebyl nalezen");
  }

  let clientVersion;
  const verResult = data.match(/['"]clientVersion['"]:\s*['"]([\d.]+?)['"]/);
  if (verResult) {
    clientVersion = verResult[1];
  } else {
    throw new Error("Verze klienta nebyla nalezena");
  }

  let continuation;
  const continuationResult = data.match(
    /['"]continuation['"]:\s*['"](.+?)['"]/,
  );
  if (continuationResult) {
    continuation = continuationResult[1];
  } else {
    throw new Error("Continuation token nebyl nalezen");
  }

  return {
    liveId,
    apiKey,
    clientVersion,
    continuation,
  };
}

/**
 * Volání Innertube API endpointu pro stažení nových zpráv
 */
async function fetchChat(options) {
  const url = `https://www.youtube.com/youtubei/v1/live_chat/get_live_chat?key=${options.apiKey}`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    },
    body: JSON.stringify({
      context: {
        client: {
          clientVersion: options.clientVersion,
          clientName: "WEB",
        },
      },
      continuation: options.continuation,
    }),
  });

  const data = await res.json();
  return parseChatData(data);
}

/**
 * Převede odpověď z get_live_chat na čistá data
 */
function parseChatData(data) {
  let chatItems = [];
  if (data.continuationContents?.liveChatContinuation?.actions) {
    chatItems = data.continuationContents.liveChatContinuation.actions
      .map((v) => parseActionToChatItem(v))
      .filter((v) => v !== null);
  }

  const continuationData =
    data.continuationContents?.liveChatContinuation?.continuations?.[0];
  let continuation = "";
  if (continuationData?.invalidationContinuationData) {
    continuation = continuationData.invalidationContinuationData.continuation;
  } else if (continuationData?.timedContinuationData) {
    continuation = continuationData.timedContinuationData.continuation;
  }

  return [chatItems, continuation];
}

function parseThumbnailToImageItem(data, alt) {
  if (!data || data.length === 0) return { url: "", alt: "" };
  const thumbnail = data[data.length - 1]; // ekvivalent k .pop() bez mutace původního pole
  return {
    url: thumbnail.url,
    alt: alt,
  };
}

function convertColorToHex6(colorNum) {
  return `#${colorNum.toString(16).slice(2).toUpperCase()}`;
}

function parseMessages(runs) {
  if (!runs) return [];
  return runs.map((run) => {
    if ("text" in run) {
      return run;
    } else if (run.emoji) {
      const thumbnail = run.emoji.image?.thumbnails?.[0];
      const isCustomEmoji = Boolean(run.emoji.isCustomEmoji);
      const shortcut = run.emoji.shortcuts ? run.emoji.shortcuts[0] : "";
      return {
        url: thumbnail ? thumbnail.url : "",
        alt: shortcut,
        isCustomEmoji: isCustomEmoji,
        emojiText: isCustomEmoji ? shortcut : run.emoji.emojiId,
      };
    }
    return run;
  });
}

function rendererFromAction(action) {
  if (!action.addChatItemAction) return null;
  const item = action.addChatItemAction.item;
  if (item.liveChatTextMessageRenderer) return item.liveChatTextMessageRenderer;
  if (item.liveChatPaidMessageRenderer) return item.liveChatPaidMessageRenderer;
  if (item.liveChatPaidStickerRenderer) return item.liveChatPaidStickerRenderer;
  if (item.liveChatMembershipItemRenderer)
    return item.liveChatMembershipItemRenderer;
  return null;
}

function parseActionToChatItem(data) {
  const messageRenderer = rendererFromAction(data);
  if (messageRenderer === null) return null;

  let message = [];
  if ("message" in messageRenderer) {
    message = messageRenderer.message.runs;
  } else if ("headerSubtext" in messageRenderer) {
    message = messageRenderer.headerSubtext.runs;
  }

  const authorNameText = messageRenderer.authorName?.simpleText ?? "";
  const ret = {
    id: messageRenderer.id,
    author: {
      name: authorNameText,
      thumbnail: parseThumbnailToImageItem(
        messageRenderer.authorPhoto?.thumbnails,
        authorNameText,
      ),
      channelId: messageRenderer.authorExternalChannelId,
    },
    message: parseMessages(message),
    isMembership: false,
    isOwner: false,
    isVerified: false,
    isModerator: false,
    timestamp: new Date(Number(messageRenderer.timestampUsec) / 1000),
  };

  if (messageRenderer.authorBadges) {
    for (const entry of messageRenderer.authorBadges) {
      const badge = entry.liveChatAuthorBadgeRenderer;
      if (badge.customThumbnail) {
        ret.author.badge = {
          thumbnail: parseThumbnailToImageItem(
            badge.customThumbnail.thumbnails,
            badge.tooltip,
          ),
          label: badge.tooltip,
        };
        ret.isMembership = true;
      } else {
        switch (badge.icon?.iconType) {
          case "OWNER":
            ret.isOwner = true;
            break;
          case "VERIFIED":
            ret.isVerified = true;
            break;
          case "MODERATOR":
            ret.isModerator = true;
            break;
        }
      }
    }
  }

  if ("sticker" in messageRenderer) {
    ret.superchat = {
      amount: messageRenderer.purchaseAmountText.simpleText,
      color: convertColorToHex6(messageRenderer.backgroundColor),
      sticker: parseThumbnailToImageItem(
        messageRenderer.sticker.thumbnails,
        messageRenderer.sticker.accessibility.accessibilityData.label,
      ),
    };
  } else if ("purchaseAmountText" in messageRenderer) {
    ret.superchat = {
      amount: messageRenderer.purchaseAmountText.simpleText,
      color: convertColorToHex6(messageRenderer.bodyBackgroundColor),
    };
  }

  return ret;
}

// --- SMYČKA PRO REÁLNÝ SPLECH CHATU ---
/**
 * Pomocná funkce pro ošetření nebezpečných znaků (ochrana proti XSS útokům v chatu)
 */
function escapeHtml(text) {
  if (!text) return "";
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

/**
 * Hlavní smyčka upravená pro generování HTML struktur
 */
async function startChatListener(streamIdentifier) {
  try {
    console.log("Inicializuji parametry z live stránky...");
    let options = await fetchLivePage(streamIdentifier);
    console.log(`Úspěšně připojeno k videu ID: ${options.liveId}`);

    while (options.continuation) {
      const [messages, nextContinuation] = await fetchChat(options);

      messages.forEach((item) => {
        // 1. Příprava odznaků (Badges) v HTML
        let badgesHtml = "";
        if (item.isOwner)
          badgesHtml += `<span class="badge streamer">[STREAMER]</span> `;
        if (item.isModerator)
          badgesHtml += `<span class="badge mod">[MOD]</span> `;
        if (item.isMembership) {
          // Pokud má uživatel ikonu věrnostního členství, vykreslíme ji
          if (item.author.badge?.thumbnail?.url) {
            badgesHtml += `<img class="member-badge" src="${item.author.badge.thumbnail.url}" title="${escapeHtml(item.author.badge.label)}" alt="badge" /> `;
          } else {
            badgesHtml += `<span class="badge member">[ČLEN]</span> `;
          }
        }

        // 2. SESTAVENÍ TĚLA ZPRÁVY DO HTML (včetně textu a emotikonů)
        const msgHtml = item.message
          .map((part) => {
            if (part.text) {
              // Text bezpečně escapujeme
              return `<span>${escapeHtml(part.text)}</span>`;
            } else if (part.url) {
              // Emotikon vykreslíme jako obrázek. Alt text poslouží při najetí myší
              const altText = escapeHtml(part.alt || "emoji");
              return `<img class="yt-emoji" src="${part.url}" title="${altText}" alt="${altText}" />`;
            }
            return "";
          })
          .join("");

        // 3. Sestavení kompletního řádku zprávy
        let finalMessageHtml = "";
        const authorName = escapeHtml(item.author.name);
        const authorAvatar = item.author.thumbnail?.url || "";

        if (item.superchat) {
          // Speciální HTML šablona pro SuperChat
          const amount = escapeHtml(item.superchat.amount);
          const bgColor = item.superchat.color || "#ffd700";

          finalMessageHtml = `
            <div class="chat-row superchat" style="border-left: 4px solid ${bgColor}">
              <img class="avatar" src="${authorAvatar}" alt="" />
              <div class="message-content">
                ${badgesHtml}<strong class="author">${authorName}</strong> 
                <span class="sc-amount" style="color: ${bgColor}">${amount}</span>
                <div class="sc-body">${msgHtml}</div>
              </div>
            </div>
          `;
        } else {
          // Standardní HTML šablona pro běžnou zprávu
          finalMessageHtml = `
            <div class="chat-row">
              <img class="avatar" src="${authorAvatar}" alt="" />
              <div class="message-content">
                ${badgesHtml}<strong class="author">${authorName}</strong>: ${msgHtml}
              </div>
            </div>
          `;
        }

        // ZDE MŮŽETE HTML KÓD ODESLAT DO VAŠEHO WEBOVÉHO ROZHRANÍ
        // Příklad: pokud používáte WebSocket (socket.io), pošlete to klientovi:
        // io.emit('new-message', finalMessageHtml);

        // Prozatím pouze vypíšeme hotový HTML řetězec do konzole pro kontrolu
        console.log(finalMessageHtml.trim());
      });

      if (!nextContinuation) {
        console.log("Chat skončil.");
        break;
      }

      options.continuation = nextContinuation;
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }
  } catch (error) {
    console.error("Chyba:", error.message);
  }
}

// --- PŘÍKLAD SPUŠTĚNÍ ---
// Můžete zadat buď handle: { handle: "@jmeno_kanalu" }, channelId nebo přímo liveId videa
startChatListener({ handle: "@DebatniDenik" });
