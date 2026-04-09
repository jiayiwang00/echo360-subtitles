class LRUCache {
  constructor(limit = 500) {
    this.limit = limit;
    this.map = new Map();
  }

  get(key) {
    if (!this.map.has(key)) return null;
    const value = this.map.get(key);
    this.map.delete(key);
    this.map.set(key, value);
    return value;
  }

  set(key, value) {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, value);
    if (this.map.size > this.limit) {
      const firstKey = this.map.keys().next().value;
      this.map.delete(firstKey);
    }
  }

  has(key) {
    return this.map.has(key);
  }
}

class SubtitleTranslationEngine {
  constructor({
    config,
    subtitles,
    initialLanguage,
    defaultLanguage,
    getCurrentIndex,
    onProgress
  }) {
    this.config = config;
    this.subtitles = subtitles;
    this.targetLanguage = initialLanguage || defaultLanguage;
    this.defaultLanguage = defaultLanguage;
    this.getCurrentIndex = getCurrentIndex;
    this.onProgress = onProgress || (() => {});

    this.textToIndices = new Map();
    this.cachesByLanguage = new Map();
    this.retryTimers = new Map();
    this.backgroundFillTimer = null;
    this.progressTimer = null;
    this.requestSlotChain = Promise.resolve();
    this.nextRequestAt = 0;
    this.generation = 0;
    this.destroyed = false;
    this.activeText = "";

    this.engine = {
      urgentQueue: [],
      backgroundQueue: [],
      queuedPriority: new Map(),
      inFlightKeys: new Set(),
      scheduledUniqueTexts: new Set(),
      completedUniqueTexts: new Set(),
      retryAttempts: new Map(),
      workersStarted: false
    };

    this.stats = {
      total: subtitles.length,
      translated: 0,
      failed: 0,
      uniqueDone: 0,
      cacheHit: 0,
      requested: 0,
      currentQueueLength: 0,
      startedAt: Date.now(),
      lastTranslatedText: "",
      workerRunning: false,
      allDone: false,
      lastPriorityIndex: -1
    };

    for (const [index, sub] of subtitles.entries()) {
      if (!this.textToIndices.has(sub.text)) this.textToIndices.set(sub.text, []);
      this.textToIndices.get(sub.text).push(index);
    }
  }

  get uniqueTotal() {
    return this.textToIndices.size;
  }

  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  makeGenerationTextKey(generation, text) {
    return `${generation}::${text}`;
  }

  getLanguageCache(language = this.targetLanguage) {
    if (!this.cachesByLanguage.has(language)) {
      this.cachesByLanguage.set(language, new LRUCache(this.config.CACHE_LIMIT));
    }
    return this.cachesByLanguage.get(language);
  }

  getActiveCache() {
    return this.getLanguageCache(this.targetLanguage);
  }

  getQueueLength() {
    return this.engine.urgentQueue.length + this.engine.backgroundQueue.length;
  }

  updateQueueStats() {
    this.stats.currentQueueLength = this.getQueueLength();
  }

  getSnapshot() {
    const percent = this.stats.total ? (this.stats.translated / this.stats.total) * 100 : 0;
    return {
      running: !this.destroyed,
      statusText: this.stats.allDone
        ? `Translation complete (${this.targetLanguage})`
        : `Translating to ${this.targetLanguage}`,
      translated: this.stats.translated,
      total: this.stats.total,
      uniqueDone: this.stats.uniqueDone,
      uniqueTotal: this.uniqueTotal,
      queueLength: this.getQueueLength(),
      percent: Number(percent.toFixed(1)),
      activeText: this.activeText
    };
  }

  syncProgress(immediate = false) {
    if (this.destroyed) return;
    this.onProgress(this.getSnapshot(), immediate);
  }

  requestProgressSync(immediate = false) {
    if (this.destroyed) return;

    if (immediate) {
      if (this.progressTimer) clearTimeout(this.progressTimer);
      this.progressTimer = null;
      this.syncProgress(true);
      return;
    }

    if (this.progressTimer) return;
    this.progressTimer = setTimeout(() => {
      this.progressTimer = null;
      this.syncProgress(false);
    }, this.config.POPUP_SYNC_INTERVAL);
  }

  setActiveText(text) {
    this.activeText = text || "";
    this.requestProgressSync();
  }

  markAllSameText(text, updater) {
    const indices = this.textToIndices.get(text) || [];
    for (const index of indices) updater(this.subtitles[index], index);
  }

  updateSubtitleState(sub, nextStatus, extras = {}) {
    const prevStatus = sub.status;

    if (prevStatus === "done" && nextStatus !== "done") this.stats.translated -= 1;
    if (prevStatus === "failed" && nextStatus !== "failed") this.stats.failed -= 1;
    if (prevStatus !== "done" && nextStatus === "done") this.stats.translated += 1;
    if (prevStatus !== "failed" && nextStatus === "failed") this.stats.failed += 1;

    sub.status = nextStatus;
    if (Object.prototype.hasOwnProperty.call(extras, "translation")) sub.translation = extras.translation;
    if (Object.prototype.hasOwnProperty.call(extras, "error")) sub.error = extras.error;
  }

  clearRetryState(text, generation) {
    const retryKey = this.makeGenerationTextKey(generation, text);
    if (this.retryTimers.has(retryKey)) {
      clearTimeout(this.retryTimers.get(retryKey));
      this.retryTimers.delete(retryKey);
    }
    this.engine.retryAttempts.delete(retryKey);
  }

  getHttpStatus(error) {
    const match = String(error?.message || "").match(/HTTP\s+(\d{3})/);
    return match ? Number(match[1]) : null;
  }

  getRetryDelay(error, attempt) {
    const status = this.getHttpStatus(error);
    const baseDelay =
      status === 429 ? 2500 : status && status >= 500 ? 1800 : this.config.RETRY_DELAY;
    const exponentialDelay = baseDelay * Math.pow(2, Math.min(attempt - 1, 4));
    const jitter = Math.floor(Math.random() * 350);
    return Math.min(this.config.MAX_RETRY_DELAY, exponentialDelay + jitter);
  }

  applyTranslationToAll(text, translation, generation, language) {
    if (this.destroyed) return;
    if (generation !== this.generation || language !== this.targetLanguage) return;

    this.clearRetryState(text, generation);

    this.markAllSameText(text, sub => {
      this.updateSubtitleState(sub, "done", { translation, error: null });
    });

    if (!this.engine.completedUniqueTexts.has(text)) {
      this.engine.completedUniqueTexts.add(text);
      this.stats.uniqueDone = this.engine.completedUniqueTexts.size;
    }

    this.requestProgressSync();
  }

  scheduleRetry(text, error, generation) {
    const retryKey = this.makeGenerationTextKey(generation, text);
    if (this.retryTimers.has(retryKey)) return;

    this.stats.allDone = false;
    const nextAttempt = (this.engine.retryAttempts.get(retryKey) || 0) + 1;
    this.engine.retryAttempts.set(retryKey, nextAttempt);
    const delay = this.getRetryDelay(error, nextAttempt);

    const timer = setTimeout(() => {
      this.retryTimers.delete(retryKey);
      if (this.destroyed || generation !== this.generation) return;
      this.enqueueText(text, "background");
    }, delay);

    this.retryTimers.set(retryKey, timer);
    this.requestProgressSync();
  }

  markFailedForAll(text, error, generation, language) {
    if (this.destroyed) return;
    if (generation !== this.generation || language !== this.targetLanguage) return;

    this.markAllSameText(text, sub => {
      if (sub.status !== "done") {
        this.updateSubtitleState(sub, "failed", { error: String(error?.message || error) });
      }
    });

    this.scheduleRetry(text, error, generation);
    this.requestProgressSync();
  }

  async googleTranslate(text, language) {
    const url =
      `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=${encodeURIComponent(language)}&dt=t&q=${encodeURIComponent(text)}`;
    const response = await fetch(url);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    return data?.[0]?.map(part => part[0]).join("") || "";
  }

  async waitForRequestSlot() {
    let releaseLock;
    const previous = this.requestSlotChain;
    this.requestSlotChain = new Promise(resolve => {
      releaseLock = resolve;
    });

    await previous;
    try {
      const wait = Math.max(0, this.nextRequestAt - Date.now());
      if (wait > 0) await this.sleep(wait);
      this.nextRequestAt = Date.now() + this.config.REQUEST_SPACING_MS;
    } finally {
      releaseLock();
    }
  }

  async translateRateLimited(text, language) {
    await this.waitForRequestSlot();
    this.stats.requested += 1;
    this.requestProgressSync();
    return this.googleTranslate(text, language);
  }

  removeFromQueue(queue, text) {
    const index = queue.indexOf(text);
    if (index === -1) return false;
    queue.splice(index, 1);
    return true;
  }

  dequeueNextText() {
    const nextText = this.engine.urgentQueue.shift() || this.engine.backgroundQueue.shift() || null;
    if (nextText) {
      this.engine.queuedPriority.delete(nextText);
      this.updateQueueStats();
    }
    return nextText;
  }

  enqueueText(text, priority = "background") {
    const normalized = String(text || "").replace(/\s+/g, " ").trim();
    if (!normalized || this.destroyed) return;

    this.stats.allDone = false;
    const activeCache = this.getActiveCache();
    const inFlightKey = this.makeGenerationTextKey(this.generation, normalized);

    if (activeCache.has(normalized)) {
      const cached = activeCache.get(normalized);
      this.stats.cacheHit += 1;
      this.applyTranslationToAll(normalized, cached, this.generation, this.targetLanguage);
      return;
    }

    if (this.engine.inFlightKeys.has(inFlightKey)) return;

    const existingPriority = this.engine.queuedPriority.get(normalized);
    if (existingPriority) {
      if (priority === "urgent" && existingPriority !== "urgent") {
        this.removeFromQueue(this.engine.backgroundQueue, normalized);
        this.engine.urgentQueue.unshift(normalized);
        this.engine.queuedPriority.set(normalized, "urgent");
        this.updateQueueStats();
        this.requestProgressSync();
      }
      return;
    }

    this.markAllSameText(normalized, sub => {
      if (sub.status === "pending" || sub.status === "failed") {
        this.updateSubtitleState(sub, "queued");
      }
    });

    this.engine.queuedPriority.set(normalized, priority);
    if (priority === "urgent") this.engine.urgentQueue.unshift(normalized);
    else this.engine.backgroundQueue.push(normalized);

    this.updateQueueStats();
    this.requestProgressSync();
  }

  isTranslationResolved() {
    return (
      this.stats.translated === this.stats.total &&
      this.getQueueLength() === 0 &&
      this.engine.inFlightKeys.size === 0 &&
      this.retryTimers.size === 0 &&
      !this.backgroundFillTimer
    );
  }

  async workerLoop() {
    while (!this.destroyed) {
      const nextText = this.dequeueNextText();
      this.requestProgressSync();

      if (!nextText) {
        if (!this.stats.allDone && this.isTranslationResolved()) {
          this.stats.allDone = true;
          this.requestProgressSync(true);
        }
        await this.sleep(120);
        continue;
      }

      const requestGeneration = this.generation;
      const requestLanguage = this.targetLanguage;
      const inFlightKey = this.makeGenerationTextKey(requestGeneration, nextText);
      this.engine.inFlightKeys.add(inFlightKey);

      this.markAllSameText(nextText, sub => {
        if (sub.status !== "done") this.updateSubtitleState(sub, "translating");
      });
      this.requestProgressSync();

      try {
        const translation = await this.translateRateLimited(nextText, requestLanguage);
        if (this.destroyed) continue;
        if (requestGeneration !== this.generation || requestLanguage !== this.targetLanguage) continue;
        this.getLanguageCache(requestLanguage).set(nextText, translation);
        this.applyTranslationToAll(nextText, translation, requestGeneration, requestLanguage);
        this.stats.lastTranslatedText = nextText;
      } catch (error) {
        console.warn("Translation failed:", nextText, error);
        this.markFailedForAll(nextText, error, requestGeneration, requestLanguage);
      } finally {
        this.engine.inFlightKeys.delete(inFlightKey);
        this.updateQueueStats();
        this.requestProgressSync();
      }
    }
  }

  ensureWorkers() {
    if (this.engine.workersStarted) return;
    this.engine.workersStarted = true;
    this.stats.workerRunning = true;

    for (let i = 0; i < this.config.MAX_CONCURRENT_REQUESTS; i++) {
      this.workerLoop().catch(error => {
        console.error("Subtitle worker crashed", error);
      });
    }
  }

  getBestTranslation(sub) {
    if (!sub || !sub.text) return null;
    if (sub.translation) return sub.translation;

    const cached = this.getActiveCache().get(sub.text);
    if (cached) {
      this.applyTranslationToAll(sub.text, cached, this.generation, this.targetLanguage);
      return cached;
    }

    return null;
  }

  requestImmediateTranslationForIndex(index) {
    const sub = this.subtitles[index];
    if (!sub || !sub.text || sub.translation || sub.status === "translating") return;

    const cached = this.getActiveCache().get(sub.text);
    if (cached) {
      this.applyTranslationToAll(sub.text, cached, this.generation, this.targetLanguage);
      return;
    }

    this.enqueueText(sub.text, "urgent");
  }

  boostLookahead(index) {
    for (let offset = 0; offset <= this.config.LOOKAHEAD_COUNT; offset++) {
      const sub = this.subtitles[index + offset];
      if (!sub || !sub.text || sub.translation) continue;

      const cached = this.getActiveCache().get(sub.text);
      if (cached) {
        this.applyTranslationToAll(sub.text, cached, this.generation, this.targetLanguage);
        continue;
      }

      this.enqueueText(sub.text, "urgent");
    }
  }

  enqueueWindowAround(index, forward = this.config.PRIORITY_FORWARD, backward = this.config.PRIORITY_BACKWARD) {
    if (index < 0) return;

    const current = this.subtitles[index];
    if (current?.text) this.enqueueText(current.text, "urgent");

    for (let i = 1; i <= forward; i++) {
      const sub = this.subtitles[index + i];
      if (sub?.text) this.enqueueText(sub.text, "urgent");
    }

    for (let i = 1; i <= backward; i++) {
      const sub = this.subtitles[index - i];
      if (sub?.text) this.enqueueText(sub.text, "urgent");
    }
  }

  enqueueRemainingFrom(index) {
    const orderedTexts = [];
    const localSeen = new Set();

    for (let i = index; i < this.subtitles.length; i++) {
      const text = this.subtitles[i]?.text;
      if (text && !localSeen.has(text)) {
        localSeen.add(text);
        orderedTexts.push(text);
      }
    }

    for (let i = 0; i < index; i++) {
      const text = this.subtitles[i]?.text;
      if (text && !localSeen.has(text)) {
        localSeen.add(text);
        orderedTexts.push(text);
      }
    }

    for (const text of orderedTexts) {
      if (!this.engine.scheduledUniqueTexts.has(text)) {
        this.engine.scheduledUniqueTexts.add(text);
        this.enqueueText(text, "background");
      }
    }
  }

  scheduleBackgroundFill(index, delay = this.config.BACKGROUND_FILL_DELAY) {
    if (this.backgroundFillTimer) clearTimeout(this.backgroundFillTimer);
    const generation = this.generation;
    this.backgroundFillTimer = setTimeout(() => {
      this.backgroundFillTimer = null;
      if (this.destroyed || generation !== this.generation) return;
      this.enqueueRemainingFrom(index);
      this.requestProgressSync();
    }, delay);
  }

  clearRuntimeState() {
    for (const timer of this.retryTimers.values()) clearTimeout(timer);
    this.retryTimers.clear();
    this.engine.retryAttempts.clear();

    if (this.backgroundFillTimer) clearTimeout(this.backgroundFillTimer);
    this.backgroundFillTimer = null;

    this.engine.urgentQueue.length = 0;
    this.engine.backgroundQueue.length = 0;
    this.engine.queuedPriority.clear();
    this.engine.inFlightKeys.clear();
    this.engine.scheduledUniqueTexts.clear();
    this.engine.completedUniqueTexts.clear();

    this.nextRequestAt = 0;
    this.stats.translated = 0;
    this.stats.failed = 0;
    this.stats.uniqueDone = 0;
    this.stats.cacheHit = 0;
    this.stats.requested = 0;
    this.stats.currentQueueLength = 0;
    this.stats.startedAt = Date.now();
    this.stats.lastTranslatedText = "";
    this.stats.allDone = false;
    this.stats.lastPriorityIndex = -1;
    this.activeText = "";

    for (const sub of this.subtitles) {
      sub.translation = null;
      sub.status = "pending";
      sub.error = null;
    }
  }

  resetTranslationState(nextLanguage) {
    this.generation += 1;
    this.targetLanguage = nextLanguage || this.defaultLanguage;
    this.clearRuntimeState();

    const currentIndex = this.getCurrentIndex();
    if (currentIndex !== -1) {
      this.enqueueWindowAround(currentIndex, this.config.PRIORITY_FORWARD, this.config.PRIORITY_BACKWARD);
      this.scheduleBackgroundFill(currentIndex, 0);
      this.stats.lastPriorityIndex = currentIndex;
    } else {
      for (const text of this.textToIndices.keys()) {
        this.engine.scheduledUniqueTexts.add(text);
        this.enqueueText(text, "background");
      }
    }

    this.requestProgressSync(true);
    this.ensureWorkers();
  }

  setTargetLanguage(nextLanguage) {
    const normalized = nextLanguage || this.defaultLanguage;
    if (normalized === this.targetLanguage) return;
    this.resetTranslationState(normalized);
  }

  handleSeek(index) {
    if (index === -1 || this.destroyed) return;
    this.enqueueWindowAround(index, this.config.PRIORITY_FORWARD, this.config.PRIORITY_BACKWARD);
    this.scheduleBackgroundFill(index);
    this.stats.lastPriorityIndex = index;
    this.requestProgressSync();
  }

  start(startIndex) {
    if (startIndex !== -1) {
      this.enqueueWindowAround(startIndex, this.config.PRIORITY_FORWARD, this.config.PRIORITY_BACKWARD);
      this.scheduleBackgroundFill(startIndex);
      this.stats.lastPriorityIndex = startIndex;
    } else {
      for (const text of this.textToIndices.keys()) {
        this.engine.scheduledUniqueTexts.add(text);
        this.enqueueText(text, "background");
      }
    }

    this.ensureWorkers();
    this.requestProgressSync(true);
  }

  destroy() {
    this.destroyed = true;
    for (const timer of this.retryTimers.values()) clearTimeout(timer);
    this.retryTimers.clear();
    if (this.backgroundFillTimer) clearTimeout(this.backgroundFillTimer);
    if (this.progressTimer) clearTimeout(this.progressTimer);
  }
}

window.SubtitleTranslationEngine = SubtitleTranslationEngine;
