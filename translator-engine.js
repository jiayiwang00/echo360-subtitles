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
    onProgress,
    getPersistedTranslation,
    savePersistedTranslation
  }) {
    this.config = config;
    this.subtitles = subtitles;
    this.targetLanguage = initialLanguage || defaultLanguage;
    this.defaultLanguage = defaultLanguage;
    this.translationProvider = config.translationProvider || "google";
    this.deepseekApiKey = config.deepseekApiKey || "";
    this.deepseekModel = config.deepseekModel || "deepseek-v4-flash";
    this.translationRequestId = config.translationRequestId || 0;
    this.translationStopped = false;
    this.fatalError = "";
    this.deepseekConsecutiveFailures = 0;
    this.deepseekRequestsInFlight = 0;
    this.lastDeepseekError = "";
    this.retryStatus = "";
    this.getCurrentIndex = getCurrentIndex;
    this.onProgress = onProgress || (() => {});
    this.getPersistedTranslation = getPersistedTranslation || (() => null);
    this.savePersistedTranslation = savePersistedTranslation || (() => {});

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
      fastLaneInFlightKeys: new Set(),
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

  getCacheKey(language = this.targetLanguage) {
    const model = this.translationProvider === "deepseek" ? this.deepseekModel : "free";
    return `${this.translationProvider}:${model}:${language}`;
  }

  getLanguageCache(language = this.targetLanguage) {
    const cacheKey = this.getCacheKey(language);
    if (!this.cachesByLanguage.has(cacheKey)) {
      this.cachesByLanguage.set(cacheKey, new LRUCache(this.config.CACHE_LIMIT));
    }
    return this.cachesByLanguage.get(cacheKey);
  }

  getActiveCache() {
    return this.getLanguageCache(this.targetLanguage);
  }

  getCachedTranslation(text, language = this.targetLanguage) {
    const cache = this.getLanguageCache(language);
    const memoryValue = cache.get(text);
    if (memoryValue) return memoryValue;

    const persistedValue = this.getPersistedTranslation({
      text,
      targetLanguage: language,
      translationProvider: this.translationProvider,
      deepseekModel: this.deepseekModel
    });
    if (!persistedValue) return null;

    cache.set(text, persistedValue);
    return persistedValue;
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
      statusText: this.fatalError
        ? "DeepSeek translation stopped"
        : this.retryStatus
        ? this.retryStatus
        : this.stats.allDone
        ? this.stats.failed > 0
          ? `Translation finished with ${this.stats.failed} failed (${this.translationProvider})`
          : `Translation complete (${this.targetLanguage}, ${this.translationProvider})`
        : `Translating to ${this.targetLanguage} with ${this.translationProvider}`,
      translated: this.stats.translated,
      total: this.stats.total,
      uniqueDone: this.stats.uniqueDone,
      uniqueTotal: this.uniqueTotal,
      queueLength: this.getQueueLength(),
      percent: Number(percent.toFixed(1)),
      activeText: this.activeText,
      errorMessage: this.fatalError
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
    const status = this.getHttpStatus(error);
    if (status && status >= 400 && status < 500 && status !== 408 && status !== 429) {
      return;
    }

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

  stopDeepSeekTranslation(error, generation, language) {
    if (this.destroyed || generation !== this.generation || language !== this.targetLanguage) return;

    this.generation += 1;
    this.translationStopped = true;
    const detail = String(error?.message || error || "Unknown error").slice(0, 300);
    this.fatalError = `DeepSeek request failed. The API key or model may be incorrect. ${detail}`;

    for (const timer of this.retryTimers.values()) clearTimeout(timer);
    this.retryTimers.clear();
    if (this.backgroundFillTimer) clearTimeout(this.backgroundFillTimer);
    this.backgroundFillTimer = null;
    this.engine.urgentQueue.length = 0;
    this.engine.backgroundQueue.length = 0;
    this.engine.queuedPriority.clear();

    for (const sub of this.subtitles) {
      if (sub.status !== "done") {
        this.updateSubtitleState(sub, "failed", { error: this.fatalError });
      }
    }

    this.stats.allDone = true;
    this.updateQueueStats();
    this.requestProgressSync(true);
  }

  async googleTranslate(text, language) {
    const url =
      `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=${encodeURIComponent(language)}&dt=t&q=${encodeURIComponent(text)}`;
    const response = await fetch(url);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    return data?.[0]?.map(part => part[0]).join("") || "";
  }

  async deepseekTranslateBatch(texts, language) {
    if (!this.deepseekApiKey) throw new Error("DeepSeek API key is required");
    if (!this.deepseekModel) throw new Error("DeepSeek model is required");

    const response = await chrome.runtime.sendMessage({
      type: "DEEPSEEK_TRANSLATE_BATCH",
      apiKey: this.deepseekApiKey,
      model: this.deepseekModel,
      targetLanguage: language,
      texts
    });

    if (!response?.ok) throw new Error(response?.error || "DeepSeek request failed");
    if (!Array.isArray(response.translations) || response.translations.length !== texts.length) {
      throw new Error("DeepSeek returned an incomplete translation batch");
    }
    return response.translations.map(translation => String(translation || "").trim());
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

  async translateRateLimited(texts, language, generation = this.generation) {
    if (this.translationProvider !== "deepseek") {
      await this.waitForRequestSlot();
      this.stats.requested += 1;
      this.requestProgressSync();
      return Promise.all(texts.map(text => this.googleTranslate(text, language)));
    }

    const maxFailures = Math.max(1, Number(this.config.DEEPSEEK_MAX_CONSECUTIVE_FAILURES) || 10);
    while (!this.destroyed && generation === this.generation && this.translationProvider === "deepseek") {
      await this.waitForRequestSlot();

      while (
        this.deepseekConsecutiveFailures < maxFailures
        && this.deepseekConsecutiveFailures + this.deepseekRequestsInFlight >= maxFailures
        && !this.destroyed
        && generation === this.generation
      ) {
        await this.sleep(25);
      }

      if (this.deepseekConsecutiveFailures >= maxFailures) {
        throw new Error(
          `DeepSeek failed ${maxFailures} consecutive attempts. Last error: ${this.lastDeepseekError || "Unknown error"}`
        );
      }

      this.stats.requested += 1;
      this.deepseekRequestsInFlight += 1;
      this.requestProgressSync();

      let requestError = null;
      try {
        const translations = await this.deepseekTranslateBatch(texts, language);
        this.deepseekConsecutiveFailures = 0;
        this.lastDeepseekError = "";
        this.retryStatus = "";
        this.requestProgressSync(true);
        return translations;
      } catch (error) {
        requestError = error;
      } finally {
        this.deepseekRequestsInFlight = Math.max(0, this.deepseekRequestsInFlight - 1);
      }

      if (requestError) {
        if (this.destroyed || generation !== this.generation || this.translationProvider !== "deepseek") {
          throw requestError;
        }

        this.deepseekConsecutiveFailures += 1;
        this.lastDeepseekError = String(requestError?.message || requestError || "Unknown error").slice(0, 300);
        const failures = this.deepseekConsecutiveFailures;
        if (failures >= maxFailures) {
          this.retryStatus = "";
          throw new Error(`DeepSeek failed ${maxFailures} consecutive attempts. Last error: ${this.lastDeepseekError}`);
        }

        this.retryStatus = `DeepSeek request failed. Retrying (${failures}/${maxFailures})...`;
        this.requestProgressSync(true);
        await this.sleep(Math.max(0, Number(this.config.DEEPSEEK_RETRY_DELAY_MS) || 800));
      }
    }

    throw new Error("DeepSeek translation was cancelled");
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

  dequeueNextBatch() {
    if (this.translationProvider !== "deepseek") {
      const text = this.dequeueNextText();
      return text ? [text] : [];
    }

    const useUrgentQueue = this.engine.urgentQueue.length > 0;
    const queue = useUrgentQueue ? this.engine.urgentQueue : this.engine.backgroundQueue;
    const configuredLimit = useUrgentQueue
      ? this.config.DEEPSEEK_URGENT_BATCH_SIZE
      : this.config.DEEPSEEK_BACKGROUND_BATCH_SIZE;
    const limit = Math.max(1, Number(configuredLimit) || 1);
    const texts = queue.splice(0, limit);
    for (const text of texts) this.engine.queuedPriority.delete(text);
    if (texts.length) this.updateQueueStats();
    return texts;
  }

  enqueueText(text, priority = "background") {
    const normalized = String(text || "").replace(/\s+/g, " ").trim();
    if (!normalized || this.destroyed || this.translationStopped) return;

    this.stats.allDone = false;
    const inFlightKey = this.makeGenerationTextKey(this.generation, normalized);

    const cached = this.getCachedTranslation(normalized);
    if (cached) {
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
      this.stats.translated + this.stats.failed === this.stats.total &&
      this.getQueueLength() === 0 &&
      this.engine.inFlightKeys.size === 0 &&
      this.retryTimers.size === 0 &&
      !this.backgroundFillTimer
    );
  }

  async workerLoop() {
    while (!this.destroyed) {
      const nextTexts = this.dequeueNextBatch();
      this.requestProgressSync();

      if (!nextTexts.length) {
        if (!this.stats.allDone && this.isTranslationResolved()) {
          this.stats.allDone = true;
          this.requestProgressSync(true);
        }
        await this.sleep(120);
        continue;
      }

      const requestGeneration = this.generation;
      const requestLanguage = this.targetLanguage;
      const requestProvider = this.translationProvider;
      const inFlightKeys = nextTexts.map(text => this.makeGenerationTextKey(requestGeneration, text));
      for (const inFlightKey of inFlightKeys) this.engine.inFlightKeys.add(inFlightKey);

      for (const text of nextTexts) {
        this.markAllSameText(text, sub => {
          if (sub.status !== "done") this.updateSubtitleState(sub, "translating");
        });
      }
      this.requestProgressSync();

      try {
        const translations = await this.translateRateLimited(nextTexts, requestLanguage, requestGeneration);
        if (this.destroyed) continue;
        if (requestGeneration !== this.generation || requestLanguage !== this.targetLanguage) continue;
        for (const [index, text] of nextTexts.entries()) {
          const translation = translations[index];
          if (!translation) throw new Error("Translation batch contains an empty result");
          if (this.engine.completedUniqueTexts.has(text)) continue;
          this.getLanguageCache(requestLanguage).set(text, translation);
          this.savePersistedTranslation({
            text,
            translation,
            targetLanguage: requestLanguage,
            translationProvider: this.translationProvider,
            deepseekModel: this.deepseekModel
          });
          this.applyTranslationToAll(text, translation, requestGeneration, requestLanguage);
          this.stats.lastTranslatedText = text;
        }
      } catch (error) {
        if (this.destroyed || requestGeneration !== this.generation || requestLanguage !== this.targetLanguage) {
          continue;
        }
        console.warn("Translation failed:", nextTexts, error);
        if (requestProvider === "deepseek") {
          this.stopDeepSeekTranslation(error, requestGeneration, requestLanguage);
        } else {
          for (const text of nextTexts) {
            this.markFailedForAll(text, error, requestGeneration, requestLanguage);
          }
        }
      } finally {
        for (const inFlightKey of inFlightKeys) this.engine.inFlightKeys.delete(inFlightKey);
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

    const cached = this.getCachedTranslation(sub.text);
    if (cached) {
      this.applyTranslationToAll(sub.text, cached, this.generation, this.targetLanguage);
      return cached;
    }

    return null;
  }

  requestImmediateTranslationForIndex(index) {
    const sub = this.subtitles[index];
    if (!sub || !sub.text || sub.translation || sub.status === "translating") return;

    const cached = this.getCachedTranslation(sub.text);
    if (cached) {
      this.applyTranslationToAll(sub.text, cached, this.generation, this.targetLanguage);
      return;
    }

    this.enqueueUrgentSequence([sub.text]);
  }

  requestSeekFastLane(index) {
    if (this.translationProvider !== "deepseek" || this.translationStopped || this.destroyed) return;
    const sub = this.subtitles[index];
    if (!sub?.text || sub.translation) return;

    const cached = this.getCachedTranslation(sub.text);
    if (cached) {
      this.applyTranslationToAll(sub.text, cached, this.generation, this.targetLanguage);
      return;
    }

    const requestGeneration = this.generation;
    const requestLanguage = this.targetLanguage;
    const text = sub.text;
    const fastLaneKey = this.makeGenerationTextKey(requestGeneration, text);
    if (this.engine.fastLaneInFlightKeys.has(fastLaneKey)) return;
    this.engine.fastLaneInFlightKeys.add(fastLaneKey);

    this.markAllSameText(text, item => {
      if (item.status !== "done") this.updateSubtitleState(item, "translating");
    });
    this.requestProgressSync();

    this.translateRateLimited([text], requestLanguage, requestGeneration)
      .then(translations => {
        if (this.destroyed || requestGeneration !== this.generation || requestLanguage !== this.targetLanguage) return;
        const translation = String(translations?.[0] || "").trim();
        if (!translation) throw new Error("DeepSeek returned an empty fast-lane translation");
        this.getLanguageCache(requestLanguage).set(text, translation);
        this.savePersistedTranslation({
          text,
          translation,
          targetLanguage: requestLanguage,
          translationProvider: "deepseek",
          deepseekModel: this.deepseekModel
        });
        this.applyTranslationToAll(text, translation, requestGeneration, requestLanguage);
        this.stats.lastTranslatedText = text;
      })
      .catch(error => {
        if (this.destroyed || requestGeneration !== this.generation || requestLanguage !== this.targetLanguage) return;
        console.warn("Seek fast-lane translation failed:", text, error);
        this.stopDeepSeekTranslation(error, requestGeneration, requestLanguage);
      })
      .finally(() => {
        this.engine.fastLaneInFlightKeys.delete(fastLaneKey);
        this.requestProgressSync();
      });
  }

  boostLookahead(index) {
    const texts = [];
    for (let offset = 0; offset <= this.config.LOOKAHEAD_COUNT; offset++) {
      const sub = this.subtitles[index + offset];
      if (!sub || !sub.text || sub.translation) continue;

      const cached = this.getCachedTranslation(sub.text);
      if (cached) {
        this.applyTranslationToAll(sub.text, cached, this.generation, this.targetLanguage);
        continue;
      }

      texts.push(sub.text);
    }
    this.enqueueUrgentSequence(texts);
  }

  enqueueUrgentSequence(texts) {
    const orderedTexts = [...new Set(texts.filter(Boolean))];
    for (let index = orderedTexts.length - 1; index >= 0; index--) {
      const text = orderedTexts[index];
      if (this.engine.queuedPriority.get(text) === "urgent") {
        this.removeFromQueue(this.engine.urgentQueue, text);
        this.engine.queuedPriority.delete(text);
      }
      this.enqueueText(text, "urgent");
    }
  }

  enqueueWindowAround(index, forward = this.config.PRIORITY_FORWARD, backward = this.config.PRIORITY_BACKWARD) {
    if (index < 0) return;

    const texts = [];
    const current = this.subtitles[index];
    if (current?.text) texts.push(current.text);

    for (let i = 1; i <= forward; i++) {
      const sub = this.subtitles[index + i];
      if (sub?.text) texts.push(sub.text);
    }

    for (let i = 1; i <= backward; i++) {
      const sub = this.subtitles[index - i];
      if (sub?.text) texts.push(sub.text);
    }
    this.enqueueUrgentSequence(texts);
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
    this.engine.fastLaneInFlightKeys.clear();
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
    this.translationStopped = false;
    this.fatalError = "";
    this.deepseekConsecutiveFailures = 0;
    this.deepseekRequestsInFlight = 0;
    this.lastDeepseekError = "";
    this.retryStatus = "";

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

  setTranslationConfig({ targetLanguage, translationProvider, deepseekApiKey, deepseekModel, translationRequestId }) {
    const nextLanguage = targetLanguage || this.defaultLanguage;
    const nextProvider = translationProvider === "deepseek" ? "deepseek" : "google";
    const nextApiKey = String(deepseekApiKey || "").trim();
    const nextModel = String(deepseekModel || "deepseek-v4-flash").trim();
    const nextRequestId = translationRequestId || 0;
    const changed = nextLanguage !== this.targetLanguage
      || nextProvider !== this.translationProvider
      || nextApiKey !== this.deepseekApiKey
      || nextModel !== this.deepseekModel
      || nextRequestId !== this.translationRequestId;

    if (!changed) return;
    this.translationProvider = nextProvider;
    this.deepseekApiKey = nextApiKey;
    this.deepseekModel = nextModel;
    this.translationRequestId = nextRequestId;
    this.resetTranslationState(nextLanguage);
  }

  handleSeek(index) {
    if (index === -1 || this.destroyed) return;
    this.requestSeekFastLane(index);
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
