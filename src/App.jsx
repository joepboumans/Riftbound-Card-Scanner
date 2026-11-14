import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { ScanDebugQueue } from './lib/scanDebugQueue.js';
import { listen } from '@tauri-apps/api/event';
import AppShell from './components/AppShell.jsx';
import BottomTabBar from './components/BottomTabBar.jsx';
import ToastNotification from './components/ToastNotification.jsx';
import NewPrintNotice from './components/NewPrintNotice.jsx';
import LoadingScreen from './components/LoadingScreen.jsx';
import ManualScanReview from './components/scanner/ManualScanReview.jsx';
import CandidateSearch from './components/scanner/CandidateSearch.jsx';
import ScanTab from './components/scan/ScanTab.jsx';
import ScanAddAnimation from './components/scan/ScanAddAnimation.jsx';
import CollectionTab from './components/collection/CollectionTab.jsx';
import SettingsTab from './components/settings/SettingsTab.jsx';
import { useCamera } from './hooks/useCamera.js';
import { useCardDetection } from './hooks/useCardDetection.js';
import { snapScan } from './lib/cardScan.js';
import { useAutoScan } from './hooks/useAutoScan.js';
import { useScanSound } from './hooks/useScanSound.js';
import { useNewPrintCheck } from './hooks/useNewPrintCheck.js';
import { downloadCSV, copyDeckList, validateForExport } from './lib/csvExporter.js';
import { getMatcher, mergeCardDatabaseUpdate, sourceImageUrlOf } from './lib/cardMatcher.js';
import { buildScanSetOptions, summarizeScanSetCoverage } from './lib/scanSets.js';
import { isDesktopRuntime } from './lib/runtime.js';
import { invokeDesktopCommand } from './lib/desktopBridge.js';
import { checkForAppUpdate, downloadAndInstallAppUpdate, relaunchApp } from './lib/appUpdater.js';
import { fetchExchangeRatesFromEcb, fetchPriceSnapshotCsvFromGithub, importPriceSnapshotCsv, loadStoredPriceMeta, isPriceSnapshotCurrent, PRICE_SOURCE_LABEL, PRICE_SOURCE_URL } from './lib/priceSync.js';
import { getPriceRecords } from './lib/indexedDB.js';
import { FALLBACK_EXCHANGE_RATE_DATE, normalizeExchangeRates } from './lib/priceFormat.js';
import { isFoilOnly } from './data/sampleCards.js';
import { isReliableScanResult } from './lib/scanQuality.js';
import { createUserConfirmedEntry, onUserConfirmed } from './lib/userConfirmation.js';
import { getLearnedReferences } from './lib/learnedReferences.js';
import { getScanArtwork } from './lib/scanEvidence.js';
import { fullNameOf } from './lib/cardData.js';
import { createCardEntry, createEntryId, restoreCardEntries, mergeCardEntries } from './lib/collection.js';
import { createPendingList, updatePendingList, refreshPendingList, isDuplicateAdd } from './lib/pendingList.js';
import { persistUserSnapshot } from './lib/userStorage.js';
import { getUserSettings } from './lib/userSettings.js';
import { cameraProfileOf } from './lib/cameraControls.js';
import { useSetting } from './hooks/useSetting.js';
import { CardRectifier } from './lib/cardRectifier.js';
import { CardTextReader } from './lib/cardTextReader.js';
import { CardTextVerification } from './lib/cardTextVerification.js';
import { SCANNER_DIAGNOSTICS_AVAILABLE, normalizeScannerExperiments } from './lib/scannerExperiments.js';
import { saveAcceptedDebugScan } from './lib/debugScanCapture.js';
import { useScanSessionRecording } from './hooks/useScanSessionRecording.js';
import { emitScanDiagnostic } from './lib/scanDiagnostics.js';

// ─── State persistence helpers ──────────────────────────────
// The scanned cards. Saved user settings live in lib/userSettings.js.
const STORAGE_KEYS = {
  SCANNED_CARDS: 'riftbound_scanned_cards',
  PENDING_CARDS: 'riftbound_pending_cards',
  RECENT_PENDING_SCAN_EVENTS: 'riftbound_recent_pending_scan_events',
};

const SCAN_ADD_ANIMATION_MS = 980;
const CARD_DATABASE_PROGRESS_EVENT = 'card-database-progress';
const APP_UPDATE_IDLE_STATE = {
  status: 'idle',
  update: null,
  message: 'App update checks are available in the desktop build.',
  progress: null,
  checkedAt: null,
  error: null,
};
const APP_UPDATE_BUSY_STATUSES = new Set(['checking', 'downloading', 'installing', 'relaunching']);

function saveToStorage(key, data) {
  try {
    localStorage.setItem(key, JSON.stringify(data));
  } catch (err) {
    console.warn('[Storage] Failed to save:', err);
  }
}

function loadFromStorage(key, fallback) {
  try {
    const stored = localStorage.getItem(key);
    return stored ? JSON.parse(stored) : fallback;
  } catch (err) {
    console.warn('[Storage] Failed to load:', err);
    return fallback;
  }
}

export default function App() {
  // ─── App State ─────────────────────────────────────────────
  const [isLoading, setIsLoading] = useState(true);
  const [loadProgress, setLoadProgress] = useState(0);
  const [loadStage, setLoadStage] = useState('db');
  const [initError, setInitError] = useState(null);
  const [initErrorType, setInitErrorType] = useState(null);
  const [runtimeInfo, setRuntimeInfo] = useState(null);

  // Scanning
  const [pendingList, setPendingList] = useState(() => createPendingList({
    rows: loadFromStorage(STORAGE_KEYS.PENDING_CARDS, []),
    recentScans: loadFromStorage(STORAGE_KEYS.RECENT_PENDING_SCAN_EVENTS, []),
  }));
  // The latest pending list, for handlers that run more than once between renders.
  const pendingListRef = useRef(pendingList);
  const replacePendingList = useCallback((list) => {
    pendingListRef.current = list;
    setPendingList(list);
  }, []);
  const pendingCards = pendingList.rows;
  const recentPendingScanEvents = pendingList.recentScans;
  const [scannedCards, setScannedCards] = useState(() =>
    restoreCardEntries(loadFromStorage(STORAGE_KEYS.SCANNED_CARDS, []))
  );

  // UI
  const [activeTab, setActiveTab] = useState('scan');
  const [notification, setNotification] = useState(null);
  const [scanAddAnimation, setScanAddAnimation] = useState(null);

  const [debugEnabled, setDebugEnabled] = useSetting('scannerDebug');
  const [scanOverlayEnabled, setScanOverlayEnabled] = useSetting('scanOverlay');
  const [scanMatching] = useSetting('scanMatching');
  const [debugCapture, setDebugCapture] = useState({ status: 'idle' });
  const lastDebugAcceptedRef = useRef(null);
  const debugSaveQueueRef = useRef(null);
  if (SCANNER_DIAGNOSTICS_AVAILABLE && !debugSaveQueueRef.current) debugSaveQueueRef.current = new ScanDebugQueue(pendingCount => setDebugCapture(previous => ({ ...previous, pendingCount })));
  const [scanCameraVisible, setScanCameraVisible] = useState(true);

  const [batchDefaults] = useSetting('batchDefaults');
  const [modelPreference] = useSetting('detectorWeights');
  const [exportFormat] = useSetting('exportFormat');
  const [scanSetFilter, setScanSetFilter] = useSetting('scanSetFilter');
  const [scanSetOptions, setScanSetOptions] = useState([{ value: 'all', label: 'All sets' }]);
  // Each card database load also refreshes saved entries' card data by id.
  const applyCardDatabase = useCallback((cards) => {
    setScanSetOptions(buildScanSetOptions(cards));
    replacePendingList(refreshPendingList(pendingListRef.current, cards));
    setScannedCards((entries) => restoreCardEntries(entries, cards));
  }, [replacePendingList]);

  const [priceSyncBusy, setPriceSyncBusy] = useState(false);
  const [cardDatabaseBusy, setCardDatabaseBusy] = useState(false);
  const [appUpdateState, setAppUpdateState] = useState(APP_UPDATE_IDLE_STATE);
  const [updateTask, setUpdateTask] = useState(null);
  const [priceSyncMeta, setPriceSyncMeta] = useState(null);
  const [priceRecords, setPriceRecords] = useState([]);
  const [priceCurrency] = useSetting('priceCurrency');
  const [cameraDeviceId, setCameraDeviceId] = useSetting('cameraDeviceId');
  const [cameraDevices, setCameraDevices] = useState([]);
  const [cameraProfiles] = useSetting('cameraProfiles');
  const cameraProfile = cameraProfileOf(cameraProfiles, cameraDeviceId);

  // ─── Hooks ─────────────────────────────────────────────────
  // Recognition features start enabled, including profiles saved with the old
  // opt-in defaults. Debug overrides last only until debug closes or app exits.
  const [scannerExperiments, setScannerExperiments] = useState(() => normalizeScannerExperiments(null));
  const rectifierRef = useRef(null);
  const refineCardCrop = useCallback((source, box) => {
    if (!rectifierRef.current) rectifierRef.current = new CardRectifier();
    return rectifierRef.current.refine(source, box);
  }, []);
  useEffect(() => {
    if (!scannerExperiments.perspective) { rectifierRef.current?.dispose(); rectifierRef.current = null; }
    return () => { rectifierRef.current?.dispose(); rectifierRef.current = null; };
  }, [scannerExperiments.perspective]);

  const textVerifierRef = useRef(null);
  const textReaderRef = useRef(null);
  if (scannerExperiments.textVerification && !textVerifierRef.current) {
    if (!textReaderRef.current) textReaderRef.current = new CardTextReader();
    textVerifierRef.current = new CardTextVerification(textReaderRef.current);
  }
  const textVerifier = scannerExperiments.textVerification ? textVerifierRef.current : null;
  useEffect(() => {
    if (!scannerExperiments.textVerification) { textVerifierRef.current?.dispose(); textVerifierRef.current = null; }
    if (!scannerExperiments.textVerification) return undefined;
    const owned = textVerifier;
    // Loading belongs to the feature lifecycle, not to the first held card.
    owned?.reader.ensureReady?.().catch(() => {});
    return () => { owned?.dispose(); if (textVerifierRef.current === owned) textVerifierRef.current = null; };
  }, [scannerExperiments.textVerification, textVerifier]);

  const camera = useCamera({ deviceId: cameraDeviceId, profile: cameraProfile });
  const detection = useCardDetection({ scanSetFilter, cropRefiner: scannerExperiments.perspective ? refineCardCrop : null, textVerifier,
    minSimilarity: scanMatching.minSimilarity, minSimilarityGap: scanMatching.minSimilarityGap,
    recognitionContext: `${cameraDeviceId}:${cameraProfile}:${camera.facingMode}:${activeTab}:${modelPreference}`, cameraIsActive: camera.isActive });
  const scanSound = useScanSound();
  const cardDatabaseInputRef = useRef(null);

  const priceByCardId = useMemo(() => new Map(priceRecords.map((record) => [record.cardId, record])), [priceRecords]);
  const priceExchangeRates = normalizeExchangeRates(priceSyncMeta?.exchangeRates || (priceSyncMeta?.usdPerEurRate ? { USD: priceSyncMeta.usdPerEurRate } : null));
  const priceExchangeRateDate = priceSyncMeta?.exchangeRateDate || priceSyncMeta?.usdPerEurRateDate || FALLBACK_EXCHANGE_RATE_DATE;
  const priceExchangeRateFallback = priceSyncMeta ? Boolean(priceSyncMeta.exchangeRateFallback ?? priceSyncMeta.usdPerEurRateFallback) : true;
  const yieldToPaint = useCallback(() => new Promise((resolve) => requestAnimationFrame(() => resolve())), []);
  const matcher = getMatcher();
  const scanRecording = SCANNER_DIAGNOSTICS_AVAILABLE ? useScanSessionRecording({videoRef:camera.videoRef,
    active:debugEnabled && camera.isActive && activeTab === 'scan' && scanCameraVisible,
    contextKey:JSON.stringify([activeTab,scanCameraVisible,scanSetFilter,scannerExperiments,cameraDeviceId,cameraProfile,camera.facingMode,modelPreference,matcher.revision]),
    metadata:{...scannerExperiments,detectorModel:modelPreference,cameraProfile,setFilter:scanSetFilter,cameraSettings:camera.settings}}) : null;
  const cardDatabaseSourceLabel = detection.detectorState === 'ready'
    ? (matcher.databaseSource === 'local' ? 'Imported locally' : 'Bundled file')
    : 'Unknown';
  const cardDatabaseUpdatedAt = detection.detectorState === 'ready' ? matcher.databaseUpdatedAt : null;
  const cardDatabaseSetCoverage = detection.detectorState === 'ready'
    ? summarizeScanSetCoverage(matcher.cards)
    : { count: 0, fullLabel: 'Unknown', label: 'Unknown' };
  const appUpdateBusy = APP_UPDATE_BUSY_STATUSES.has(appUpdateState.status);
  const userSnapshotRef = useRef(null);
  userSnapshotRef.current = {
    [STORAGE_KEYS.SCANNED_CARDS]: scannedCards,
    [STORAGE_KEYS.PENDING_CARDS]: pendingCards,
    [STORAGE_KEYS.RECENT_PENDING_SCAN_EVENTS]: recentPendingScanEvents,
  };

  useEffect(() => {
    let cancelled = false;

    if (!isDesktopRuntime()) {
      setRuntimeInfo(null);
      return undefined;
    }

    invokeDesktopCommand('runtime_info')
      .then((info) => {
        if (!cancelled) {
          setRuntimeInfo(info);
        }
      })
      .catch((error) => {
        console.warn('[App] Desktop runtime info unavailable:', error);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const refreshCameraDevices = useCallback(async () => {
    if (!navigator.mediaDevices?.enumerateDevices) {
      setCameraDevices([]);
      return;
    }

    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const videoInputs = devices
        .filter((device) => device.kind === 'videoinput')
        .map((device, index) => ({
          deviceId: device.deviceId,
          label: device.label || `Camera ${index + 1}`,
        }));
      setCameraDevices(videoInputs);
    } catch (error) {
      console.warn('[App] Could not enumerate camera devices:', error);
      setCameraDevices([]);
    }
  }, []);

  useEffect(() => {
    refreshCameraDevices();
  }, [refreshCameraDevices, camera.isActive]);

  useEffect(() => {
    if (!navigator.mediaDevices?.addEventListener) return undefined;

    const handleDeviceChange = () => {
      refreshCameraDevices();
    };

    navigator.mediaDevices.addEventListener('devicechange', handleDeviceChange);
    return () => {
      navigator.mediaDevices.removeEventListener('devicechange', handleDeviceChange);
    };
  }, [refreshCameraDevices]);

  useEffect(() => {
    if (!cameraDeviceId || cameraDevices.length === 0) return;
    const deviceStillExists = cameraDevices.some((device) => device.deviceId === cameraDeviceId);
    if (!deviceStillExists) {
      setCameraDeviceId('');
    }
  }, [cameraDeviceId, cameraDevices]);

  // Restart camera when switching back to scan tab (video element was destroyed on unmount)
  const prevTabRef = useRef(activeTab);
  useEffect(() => {
    if (activeTab === 'scan' && prevTabRef.current !== 'scan' && camera.isActive) {
      camera.startCamera();
    }
    prevTabRef.current = activeTab;
  }, [activeTab, camera.isActive, camera.startCamera]);

  // ─── Notifications ─────────────────────────────────────────
  const notificationTimeoutRef = useRef(null);

  const showNotification = useCallback((message, type = 'info') => {
    setNotification({ message, type });
    if (notificationTimeoutRef.current) {
      clearTimeout(notificationTimeoutRef.current);
    }
    notificationTimeoutRef.current = setTimeout(() => {
      setNotification(null);
    }, 2000);
  }, []);

  useEffect(() => {
    if (!scanAddAnimation) return undefined;

    const timer = setTimeout(() => {
      setScanAddAnimation(null);
    }, SCAN_ADD_ANIMATION_MS);

    return () => clearTimeout(timer);
  }, [scanAddAnimation]);

  // ─── Initialization ────────────────────────────────────────
  const hasShownRestoreNotification = useRef(false);

  const processCardDatabase = useCallback(async (parsed) => {
    if (!parsed || !Array.isArray(parsed.cards) || parsed.cards.length === 0) {
      throw new Error('The selected file does not look like a valid card-hashes.json database.');
    }

    const matcher = getMatcher();
    await matcher.setDatabase(parsed);
    applyCardDatabase(matcher.cards);

    const loadedCount = parsed.cards.length;
    showNotification(`Card database updated — ${loadedCount} cards loaded`, 'success');

    if (initErrorType !== 'model') {
      setInitError(null);
      setInitErrorType(null);
    }
  }, [applyCardDatabase, initErrorType, showNotification]);

  const processCardDatabaseText = useCallback(async (text) => {
    await processCardDatabase(JSON.parse(text));
  }, [processCardDatabase]);

  const refreshPriceCache = useCallback(async () => {
    try {
      const [meta, records] = await Promise.all([
        loadStoredPriceMeta(),
        getPriceRecords(),
      ]);

      const current = isPriceSnapshotCurrent(meta);
      setPriceSyncMeta(meta ? { ...meta, requiresRefresh: !current } : null);
      setPriceRecords(current ? records : []);
    } catch (error) {
      console.warn('[App] Price sync metadata unavailable:', error);
    }
  }, []);

  const formatInitError = useCallback((error) => {
    const message = error?.message || 'Initialization failed.';
    if (message.includes('card hash database') || message.includes('card-hashes.json')) {
      return {
        message: `${message}\n\nThe app cannot identify cards until the generated hash file exists.`,
        type: 'hashes',
      };
    }
    if (message.includes('/models/') || message.includes('model')) {
      return {
        message: `${message}\n\nThe detector weights are missing or unreadable.`,
        type: 'model',
      };
    }
    return { message, type: 'unknown' };
  }, []);

  const initializeApp = useCallback(async () => {
    try {
      setInitError(null);
      setInitErrorType(null);

      // Stage 1: Initialize YOLO detector (warmup) with model preference
      setLoadStage('model');
      setLoadProgress(0.2);
      await detection.initDetector(modelPreference);
      setLoadProgress(0.5);

      // Stage 2: Initialize card matcher (loads card-hashes.json or local DB)
      setLoadStage('matcher');
      const matcher = getMatcher();
      await matcher.initialize();
      applyCardDatabase(matcher.cards);
      setLoadProgress(0.85);

      // Done
      setLoadStage('ready');
      setLoadProgress(1);
      await new Promise(r => setTimeout(r, 400));
      setIsLoading(false);
    } catch (error) {
      console.error('[App] Initialization error:', error);
      const formatted = formatInitError(error);
      setInitError(formatted.message);
      setInitErrorType(formatted.type);
      setIsLoading(false);
    }
  }, [applyCardDatabase, detection.initDetector, formatInitError, modelPreference]);

  useEffect(() => {
    initializeApp();
  }, [initializeApp]);

  useEffect(() => {
    refreshPriceCache();
  }, [refreshPriceCache]);

  const getLocalCardIds = useCallback(() => getMatcher().cards
    .map((card) => String(card.id || '').trim())
    .filter(Boolean), []);
  const newPrints = useNewPrintCheck({ ready: !isLoading && !initError, getKnownIds: getLocalCardIds });
  const refreshNewPrints = newPrints.refresh;

  const handleUpdateCardDatabase = useCallback(async () => {
    if (cardDatabaseBusy) {
      return;
    }

    if (isDesktopRuntime()) {
      setCardDatabaseBusy(true);
      setUpdateTask({
        title: 'Updating card database',
        detail: 'Checking the Riot gallery for new and changed cards...',
        progress: 0.02,
      });
      await yieldToPaint();

      try {
        const matcher = getMatcher();
        const knownCards = matcher.cards
          .map((card) => ({ id: String(card.id || '').trim(), sourceImageUrl: sourceImageUrlOf(card) }))
          .filter((card) => card.id);
        const unlisten = await listen(CARD_DATABASE_PROGRESS_EVENT, (event) => {
          const progress = event.payload || {};
          const percent = Number(progress.percent);

          if (!Number.isFinite(percent)) {
            return;
          }

          setUpdateTask((current) => current ? {
            ...current,
            detail: progress.message || current.detail,
            progress: Math.max(current.progress, Math.min(1, percent)),
          } : current);
        });

        let text;
        try {
          text = await invokeDesktopCommand('update_card_database', { knownCards, gridSize: matcher.gridSize });
        } finally {
          unlisten();
        }

        const updateDatabase = JSON.parse(text);
        const mergedDatabase = mergeCardDatabaseUpdate(
          { gridSize: matcher.gridSize, cards: matcher.cards },
          updateDatabase
        );
        setUpdateTask({
          title: 'Updating card database',
          detail: 'Importing the refreshed matcher database...',
          progress: 0.96,
        });
        await processCardDatabase(mergedDatabase);
        if (updateDatabase.skippedCards > 0) {
          showNotification(`${updateDatabase.skippedCards} cards could not be downloaded. Run Update Card Database again to retry them.`, 'info');
        }
        setUpdateTask({
          title: 'Updating card database',
          detail: 'Refreshing local set filters...',
          progress: 0.98,
        });
        applyCardDatabase(getMatcher().cards);
        refreshNewPrints();
        setUpdateTask({
          title: 'Updating card database',
          detail: 'Card database update complete.',
          progress: 1,
        });
        await new Promise((resolve) => setTimeout(resolve, 150));
        return;
      } catch (error) {
        console.error('[App] Desktop card database update error:', error);
        showNotification(`Card database update failed: ${error.message}`, 'error');
        return;
      } finally {
        setCardDatabaseBusy(false);
        setUpdateTask(null);
      }
    }

    cardDatabaseInputRef.current?.click();
  }, [applyCardDatabase, cardDatabaseBusy, processCardDatabase, refreshNewPrints, showNotification, yieldToPaint]);

  const handleImportCardDatabase = useCallback(() => {
    cardDatabaseInputRef.current?.click();
  }, []);

  const handleCardDatabaseFileSelected = useCallback(async (event) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;

    try {
      const text = await file.text();
      await processCardDatabaseText(text);
      applyCardDatabase(getMatcher().cards);
    } catch (error) {
      console.error('[App] Card database import error:', error);
      showNotification(`Card database update failed: ${error.message}`, 'error');
    }
  }, [applyCardDatabase, processCardDatabaseText, showNotification]);

  const handleImportPriceSnapshot = useCallback(async () => {
    if (priceSyncBusy) {
      return;
    }

    setPriceSyncBusy(true);
    setUpdateTask({
      title: 'Updating price cache',
      detail: 'Fetching the latest cards.csv snapshot...',
      progress: 0.12,
    });
    await yieldToPaint();

    try {
      setUpdateTask({
        title: 'Updating price cache',
        detail: 'Refreshing currency conversion rates...',
        progress: 0.42,
      });
      const text = await fetchPriceSnapshotCsvFromGithub();
      let exchangeRateOptions = {};

      try {
        exchangeRateOptions = isDesktopRuntime()
          ? await invokeDesktopCommand('fetch_exchange_rates')
          : await fetchExchangeRatesFromEcb();
      } catch (error) {
        console.warn('[App] Retaining previous currency rates:', error);
        exchangeRateOptions = { exchangeRates: priceExchangeRates, exchangeRateDate: priceExchangeRateDate,
          exchangeRateSource: priceSyncMeta?.exchangeRateSource || 'bundled', exchangeRateFallback: true };
      }

      const result = await importPriceSnapshotCsv(text, {
        sourceHint: PRICE_SOURCE_URL,
        matcher: getMatcher(),
        ...exchangeRateOptions,
      });
      setUpdateTask({
        title: 'Updating price cache',
        detail: 'Saving matched price rows and FX metadata...',
        progress: 0.8,
      });
      await refreshPriceCache();
      const rateLabel = result.exchangeRate
        ? `, ${result.exchangeRate.exchangeRateFallback ? 'fallback' : 'ECB'} FX ${result.exchangeRate.exchangeRateDate || 'latest'}`
        : '';
      showNotification(`Price cache updated from GitHub — ${result.matchedRows}/${result.totalRows} cards matched${rateLabel}`, 'success');
    } catch (error) {
      console.error('[App] Price import error:', error);
      showNotification(`Price update failed: ${error.message}`, 'error');
    } finally {
      setPriceSyncBusy(false);
      setUpdateTask(null);
    }
  }, [priceSyncBusy, refreshPriceCache, showNotification, priceExchangeRates, priceExchangeRateDate, priceSyncMeta]);

  const handleCheckAppUpdate = useCallback(async (options = {}) => {
    const silent = Boolean(options?.silent);

    if (!isDesktopRuntime()) {
      const nextState = {
        ...APP_UPDATE_IDLE_STATE,
        status: 'unavailable',
        message: 'App updates are only available in the Windows desktop build.',
        checkedAt: new Date().toISOString(),
      };
      setAppUpdateState(nextState);
      if (!silent) {
        showNotification(nextState.message, 'info');
      }
      return null;
    }

    setAppUpdateState((previous) => ({
      ...previous,
      status: 'checking',
      message: 'Checking for app updates...',
      error: null,
      progress: null,
    }));

    try {
      const update = await checkForAppUpdate();
      const checkedAt = new Date().toISOString();

      if (update) {
        setAppUpdateState({
          status: 'available',
          update,
          message: `Version ${update.version} is available.`,
          progress: null,
          checkedAt,
          error: null,
        });
        showNotification(`App update available: v${update.version}`, 'info');
        return update;
      }

      setAppUpdateState({
        status: 'current',
        update: null,
        message: 'Riftbound Scanner is up to date.',
        progress: null,
        checkedAt,
        error: null,
      });
      if (!silent) {
        showNotification('Riftbound Scanner is up to date', 'success');
      }
      return null;
    } catch (error) {
      const message = error?.message || 'Update check failed.';
      console.error('[App] App update check failed:', error);
      setAppUpdateState((previous) => ({
        ...previous,
        status: 'error',
        message,
        error: message,
        progress: null,
        checkedAt: new Date().toISOString(),
      }));
      if (!silent) {
        showNotification(`Update check failed: ${message}`, 'error');
      }
      return null;
    }
  }, [showNotification]);

  const handleInstallAppUpdate = useCallback(async () => {
    const update = appUpdateState.update;
    if (!update || appUpdateBusy) {
      return;
    }

    setAppUpdateState((previous) => ({
      ...previous,
      status: 'downloading',
      message: `Downloading version ${update.version}...`,
      progress: { percent: 0, downloadedBytes: 0, totalBytes: null },
      error: null,
    }));

    try {
      await downloadAndInstallAppUpdate(update, (progress) => {
        setAppUpdateState((previous) => ({
          ...previous,
          status: progress.status === 'installing' ? 'installing' : 'downloading',
          message: progress.status === 'installing'
            ? 'Installing update...'
            : `Downloading version ${update.version}...`,
          progress,
        }));
      }, { beforeInstall: async () => {
        camera.stopCamera();
        await yieldToPaint();
        persistUserSnapshot({ ...userSnapshotRef.current, ...getUserSettings().snapshot() });
      } });

      setAppUpdateState((previous) => ({
        ...previous,
        status: 'relaunching',
        message: 'Update installed. Restarting Riftbound Scanner...',
        progress: { percent: 100 },
      }));
      showNotification('Update installed. Restarting...', 'success');
      await relaunchApp();
    } catch (error) {
      const message = error?.message || 'Update installation failed.';
      console.error('[App] App update install failed:', error);
      setAppUpdateState((previous) => ({
        ...previous,
        status: 'error',
        message,
        error: message,
        progress: null,
      }));
      showNotification(`Update install failed: ${message}`, 'error');
    }
  }, [appUpdateBusy, appUpdateState.update, showNotification, camera.stopCamera, yieldToPaint]);

  const hasCheckedForAppUpdate = useRef(false);
  useEffect(() => {
    if ((isLoading && !initError) || hasCheckedForAppUpdate.current || !isDesktopRuntime()) {
      return undefined;
    }

    hasCheckedForAppUpdate.current = true;
    const timer = setTimeout(() => {
      handleCheckAppUpdate({ silent: true });
    }, 1600);

    return () => clearTimeout(timer);
  }, [handleCheckAppUpdate, initError, isLoading]);

  // Show notification if state was restored from previous session
  useEffect(() => {
    if (!isLoading && !hasShownRestoreNotification.current) {
      const restoredCount = scannedCards.length + pendingCards.length;
      if (restoredCount > 0) {
        setTimeout(() => {
          showNotification(`Session restored — ${restoredCount} card${restoredCount !== 1 ? 's' : ''} recovered`, 'success');
        }, 500);
      }
      hasShownRestoreNotification.current = true;
    }
  }, [isLoading, scannedCards.length, pendingCards.length, showNotification]);

  // ─── State persistence ───────────────────────────────────
  useEffect(() => {
    saveToStorage(STORAGE_KEYS.SCANNED_CARDS, scannedCards);
  }, [scannedCards]);

  useEffect(() => {
    saveToStorage(STORAGE_KEYS.PENDING_CARDS, pendingCards);
  }, [pendingCards]);

  useEffect(() => {
    saveToStorage(STORAGE_KEYS.RECENT_PENDING_SCAN_EVENTS, recentPendingScanEvents);
  }, [recentPendingScanEvents]);

  useEffect(() => {
    if (scanSetFilter.length === 0) return;

    const availableSets = new Set(scanSetOptions.filter((option) => option.value !== 'all').map((option) => option.value));
    const nextSelection = scanSetFilter.filter((setCode) => availableSets.has(setCode));
    if (nextSelection.length !== scanSetFilter.length) {
      setScanSetFilter(nextSelection);
    }
  }, [scanSetFilter, scanSetOptions]);

  // Force save on page visibility change
  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'hidden') {
        saveToStorage(STORAGE_KEYS.SCANNED_CARDS, scannedCards);
        saveToStorage(STORAGE_KEYS.PENDING_CARDS, pendingCards);
        saveToStorage(STORAGE_KEYS.RECENT_PENDING_SCAN_EVENTS, recentPendingScanEvents);
      }
    };

    const handleBeforeUnload = () => {
      saveToStorage(STORAGE_KEYS.SCANNED_CARDS, scannedCards);
      saveToStorage(STORAGE_KEYS.PENDING_CARDS, pendingCards);
      saveToStorage(STORAGE_KEYS.RECENT_PENDING_SCAN_EVENTS, recentPendingScanEvents);
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    window.addEventListener('beforeunload', handleBeforeUnload);
    window.addEventListener('pagehide', handleBeforeUnload);

    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      window.removeEventListener('beforeunload', handleBeforeUnload);
      window.removeEventListener('pagehide', handleBeforeUnload);
    };
  }, [scannedCards, pendingCards, recentPendingScanEvents]);

  // ─── Refs for use in callbacks without stale closures ──
  const batchDefaultsRef = useRef(batchDefaults);
  useEffect(() => { batchDefaultsRef.current = batchDefaults; }, [batchDefaults]);
  const passesScanThreshold = useCallback((result) => {
    return isReliableScanResult(result, scanMatching.minSimilarity);
  }, [scanMatching.minSimilarity]);

  const mergeCardsIntoCollection = useCallback((cardsToAdd) => {
    setScannedCards((prev) => mergeCardEntries(prev, cardsToAdd));
  }, []);

  // Every change to the pending list goes through here: apply the event, then
  // do what it asks for.
  const dispatchPending = useCallback((event) => {
    const update = updatePendingList(pendingListRef.current, { now: Date.now(), ...event });
    replacePendingList(update.list);
    // Undoing a wrong pick: its user-confirmed scans must not teach the matcher.
    for (const id of update.effects.forgetLearnedReferences) getLearnedReferences().remove(id);
    if (update.effects.toCollection.length > 0) mergeCardsIntoCollection(update.effects.toCollection);
    return update;
  }, [mergeCardsIntoCollection, replacePendingList]);

  const announcePendingEntry = useCallback((entry) => {
    setScanAddAnimation({
      key: entry.entryId,
      cardData: entry.cardData,
      priceRecord: priceByCardId.get(entry.cardData.id) || null,
    });
    showNotification('+ ' + fullNameOf(entry.cardData) + (entry.quantity > 1 ? ' x' + entry.quantity : ''), 'success');
    navigator.vibrate?.(50);
  }, [priceByCardId, showNotification]);

  const handleCardDetected = useCallback((result) => {
    if (result?.acceptedByFakeScan) return false;
    if (!result?.cardData?.id || !passesScanThreshold(result)) return false;
    const entry = createCardEntry({
      cardData: result.cardData,
      confidence: result.confidence,
      similarity: result.similarity,
      scanTimestamp: result.timestamp,
    }, batchDefaultsRef.current);
    // Handled, not added: auto scan locks the card instead of retrying.
    const { outcome, effects } = dispatchPending({ type: 'accepted-scan', entry });
    if (outcome === 'duplicate') return true;
    announcePendingEntry(effects.added);
    scanSound.playScanAccepted();
    emitScanDiagnostic('queued',{result});
    return true;
  }, [passesScanThreshold, dispatchPending, announcePendingEntry, scanSound.playScanAccepted]);

  const handleAddPendingCard = useCallback((cardData, options = {}) => {
    if (!cardData) return;
    const entry = createCardEntry({
      cardData,
      ...options,
      confidence: 1,
      similarity: 1,
      manualAdded: true,
    }, batchDefaultsRef.current);
    announcePendingEntry(dispatchPending({ type: 'added-by-hand', entry }).effects.added);
  }, [dispatchPending, announcePendingEntry]);

  const captureAcceptedDebugScan = useCallback(result => {
    if(!SCANNER_DIAGNOSTICS_AVAILABLE)return;
    const queue = debugSaveQueueRef.current;
    if (queue.jobs.has(result.frameId)) return queue.jobs.get(result.frameId).promise;
    lastDebugAcceptedRef.current = result;
    setDebugCapture({ status: 'saving', card: result.cardData, frameId: result.frameId, pendingCount: queue.size + 1 });
    return queue.enqueue(result.frameId, async () => {
      emitScanDiagnostic('accepted-capture-start',{frameId:result.frameId});
      try {
        const saved = await saveAcceptedDebugScan(result, { ...scannerExperiments, detectorMode: detection.detectorMode, cameraProfile,
          setFilter: scanSetFilter, cameraSettings: camera.settings });
        if (lastDebugAcceptedRef.current === result) setDebugCapture({ status: 'saved', card: result.cardData, frameId: result.frameId, ...saved });
        emitScanDiagnostic('accepted-capture-saved',{frameId:result.frameId});
      } catch (error) {
        if (lastDebugAcceptedRef.current === result) setDebugCapture({ status: 'error', card: result.cardData, frameId: result.frameId, error: String(error?.message || error) });
        emitScanDiagnostic('accepted-capture-error',{frameId:result.frameId,error:String(error?.message || error)});
      }
    });
  }, [scannerExperiments, detection.detectorMode, cameraProfile, scanSetFilter, camera.settings]);

  const handleDebugChange = useCallback(value => {
    if(!SCANNER_DIAGNOSTICS_AVAILABLE)return;
    setDebugEnabled(value);
    if (!value) setScannerExperiments(normalizeScannerExperiments(null));
  }, []);

  // "Not these, search…" for one scan: { scan, from }. Auto scan pauses while it is open.
  const [candidateSearch, setCandidateSearch] = useState(null);

  const autoScan = useAutoScan({
    cameraIsActive: camera.isActive && activeTab === 'scan' && scanCameraVisible,
    isProcessing: detection.isProcessing || Boolean(candidateSearch) || (debugEnabled && debugCapture.pendingCount >= 3),
    detectSingleFrame: detection.detectSingleFrame,
    captureFrame: camera.captureFrame,
    onCardDetected: handleCardDetected,
    validateResult: passesScanThreshold,
    resetRecognition: detection.resetRecognition,
    debugEnabled,
    onDebugAccepted: captureAcceptedDebugScan,
    recognitionContext: JSON.stringify([activeTab, scanCameraVisible, scanSetFilter, debugEnabled, scannerExperiments, scanMatching,
      cameraDeviceId, cameraProfile, camera.facingMode, modelPreference, matcher.revision]),
  });

  const snapBusyRef = useRef(false);
  const [manualScanReview, setManualScanReview] = useState(null);
  useEffect(() => { setManualScanReview(null); setCandidateSearch(null); }, [activeTab, camera.isActive, scanSetFilter, autoScan.autoScanEnabled, autoScan.fakeScanEnabled]);
  const autoEnabledRef = useRef(autoScan.autoScanEnabled || autoScan.fakeScanEnabled);
  autoEnabledRef.current = autoScan.autoScanEnabled || autoScan.fakeScanEnabled;

  const handleSnapScan = useCallback(async () => {
    if (!camera.isActive || detection.isProcessing || snapBusyRef.current || autoEnabledRef.current || manualScanReview) return;
    snapBusyRef.current = true;
    try {
      const { result, review } = await snapScan(
        () => detection.detectSingleFrame(camera.captureFrame, { includeCandidate: true, includeReview: true }),
        { textVerifier, minSimilarity: scanMatching.minSimilarity });

      if (autoEnabledRef.current) return;
      if (result?.matched && handleCardDetected(result)) {
        autoScan.setLastCardId(result.cardData.id);
      } else if (review) {
        setManualScanReview(review);
      } else {
        showNotification('No card accepted — hold the card steady or review it manually', 'info');
      }
    } finally { snapBusyRef.current = false; }
  }, [camera.isActive, camera.captureFrame, detection, handleCardDetected, showNotification, autoScan, textVerifier, scanMatching.minSimilarity, manualScanReview]);

  // The one accept path for the Choice strip and Snap review. It skips the
  // acceptance rules on purpose: the user vouches for the card.
  const confirmCandidate = useCallback((scan, card, { from, rank = null }) => {
    // Fake and debug scans never reach the pending list or learned references.
    if (!card?.id || debugEnabled || autoScan.fakeScanEnabled) return false;
    const now = Date.now();
    // Checked before the scan is handed to learned references, so a duplicate saves nothing.
    if (isDuplicateAdd(pendingListRef.current, card.id, now)) {
      showNotification(fullNameOf(card) + ' was just added', 'info');
      return false;
    }
    const entry = createUserConfirmedEntry(scan, card, { from, rank }, batchDefaultsRef.current);
    const learnedReferenceId = onUserConfirmed({ entry, card: entry.cardData, from, rank, artwork: getScanArtwork(scan) || null });
    const { effects } = dispatchPending({ type: 'user-confirmed-scan', entry, learnedReferenceId, now });
    announcePendingEntry(effects.added);
    scanSound.playScanAccepted();
    autoScan.setLastCardId(card.id);
    return true;
  }, [dispatchPending, announcePendingEntry, scanSound.playScanAccepted, autoScan, debugEnabled, showNotification]);

  const handleUpdatePendingCard = useCallback((entryId, patch) => {
    dispatchPending({ type: 'row-edited', entryId, patch });
  }, [dispatchPending]);

  const handleConfirmPending = useCallback((entryId) => {
    const [row] = dispatchPending({ type: 'moved-to-collection', entryIds: [entryId] }).effects.toCollection;
    if (row) showNotification(fullNameOf(row.cardData) + ' added to collection', 'success');
  }, [dispatchPending, showNotification]);

  const handleConfirmAllPending = useCallback(() => {
    const moved = dispatchPending({ type: 'moved-to-collection', all: true }).effects.toCollection;
    if (moved.length > 0) showNotification(moved.length + ' card rows added to collection', 'success');
  }, [dispatchPending, showNotification]);

  const handleRemovePending = useCallback((entryId) => {
    dispatchPending({ type: 'row-removed', entryId });
  }, [dispatchPending]);

  const handleAdjustPendingQuantity = useCallback((entryId, delta) => {
    dispatchPending({ type: 'quantity-adjusted', entryId, delta });
  }, [dispatchPending]);

  const handleClearPending = useCallback(() => {
    dispatchPending({ type: 'cleared' });
  }, [dispatchPending]);

  const handleUpdateCard = useCallback((index, updatedCard) => {
    setScannedCards((prev) => prev.map((entry, i) => i === index
      ? createCardEntry({ ...updatedCard, entryId: entry.entryId })
      : entry));
  }, []);

  const handleRemoveCard = useCallback((index) => {
    setScannedCards((prev) => prev.filter((_, i) => i !== index));
  }, []);

  const handleSplitCardVariant = useCallback((index) => {
    setScannedCards((prev) => {
      const card = prev[index];
      if (!card || card.quantity < 2 || isFoilOnly(card.cardData)) return prev;
      const updated = prev.map((entry, i) => i === index ? { ...entry, quantity: entry.quantity - 1 } : entry);
      return mergeCardEntries(updated, [{
        ...card,
        entryId: createEntryId(),
        quantity: 1,
        foil: !card.foil,
        scanTimestamp: Date.now(),
      }]);
    });
    showNotification('Separated 1 copy into the other finish', 'info');
  }, [showNotification]);

  const handleClearAll = useCallback(() => {
    if (scannedCards.length === 0 || !confirm('Delete all cards from export list?')) return;
    setScannedCards([]);
  }, [scannedCards.length]);

  const handleAddCardToExport = useCallback((payload) => {
    const entry = createCardEntry(payload, batchDefaultsRef.current);
    mergeCardsIntoCollection([entry]);
    showNotification('+ ' + fullNameOf(entry.cardData), 'success');
  }, [mergeCardsIntoCollection, showNotification]);

  const handleAddCardsToExport = useCallback((payloads) => {
    mergeCardsIntoCollection(payloads.map((payload) => createCardEntry(payload, batchDefaultsRef.current)));
    showNotification(payloads.length + ' card rows added to collection', 'success');
  }, [mergeCardsIntoCollection, showNotification]);

  // ─── CSV Export ────────────────────────────────────────────
  const handleExport = useCallback(() => {
    const { valid, errors } = validateForExport(scannedCards, exportFormat);
    if (!valid) {
      showNotification(`Error: ${errors[0]}`, 'error');
      return;
    }

    const result = downloadCSV(scannedCards, null, exportFormat);
    if (result.success) {
      showNotification(
        `Downloaded: ${result.filename} (${result.format}, ${scannedCards.length} cards)${result.notice ? ` · ${result.notice}` : ''}`,
        'success'
      );
    }
  }, [scannedCards, showNotification, exportFormat]);

  const handleCopyDeckList = useCallback(async () => {
    const result = await copyDeckList(scannedCards);
    showNotification(result.message, result.success ? 'success' : 'error');
  }, [scannedCards, showNotification]);

  // ─── Render ────────────────────────────────────────────────
  const cardDatabaseInput = (
    <input
      ref={cardDatabaseInputRef}
      type="file"
      accept="application/json,.json"
      className="hidden"
      onChange={handleCardDatabaseFileSelected}
    />
  );

  if (initError) {
    return (
      <>
        {cardDatabaseInput}
        <LoadingScreen
          progress={loadProgress}
          stage={loadStage}
          error={initError}
          onImportCardDatabase={initErrorType === 'hashes' ? handleImportCardDatabase : null}
          appUpdateState={appUpdateState}
          onCheckAppUpdate={isDesktopRuntime() ? handleCheckAppUpdate : null}
          onInstallAppUpdate={handleInstallAppUpdate}
        />
      </>
    );
  }

  if (isLoading) {
    return <LoadingScreen progress={loadProgress} stage={loadStage} />;
  }

  return (
    <AppShell>
      {cardDatabaseInput}
      {manualScanReview && <ManualScanReview result={manualScanReview} onClose={() => setManualScanReview(null)}
        qualityWarning={manualScanReview.quality?.acceptable === false}
        onSelect={(card, rank) => {
          confirmCandidate(manualScanReview, card, { from: 'snap', rank });
          setManualScanReview(null);
        }}
        onSearch={() => { setCandidateSearch({ scan: manualScanReview, from: 'snap' }); setManualScanReview(null); }} />}
      {candidateSearch && <CandidateSearch setFilter={scanSetFilter} onClose={() => setCandidateSearch(null)}
        onPick={(card) => {
          confirmCandidate(candidateSearch.scan, card, { from: candidateSearch.from, rank: null });
          setCandidateSearch(null);
        }} />}

      <NewPrintNotice count={newPrints.count} onUpdate={handleUpdateCardDatabase} onLater={newPrints.later}
        disabled={priceSyncBusy || cardDatabaseBusy || appUpdateBusy} />

      {/* Tab content */}
      <div className="flex-1 flex flex-col min-h-0">
        {activeTab === 'scan' && (
          <ScanTab
            camera={camera}
            onCameraViewChange={setScanCameraVisible}
            detection={detection}
            onSnapScan={handleSnapScan}
            onConfirmCandidate={confirmCandidate}
            onSearchCandidate={(scan, from) => setCandidateSearch({ scan, from })}
            choiceStripEnabled={autoScan.autoScanEnabled && !debugEnabled && !autoScan.fakeScanEnabled && !candidateSearch && !manualScanReview}
            pendingCards={pendingCards}
            onAddPendingCard={handleAddPendingCard}
            onUpdatePendingCard={handleUpdatePendingCard}
            onConfirmPending={handleConfirmPending}
            onConfirmAllPending={handleConfirmAllPending}
            onRemovePending={handleRemovePending}
            onAdjustPendingQuantity={handleAdjustPendingQuantity}
            onClearPending={handleClearPending}
            onAddCardToExport={handleAddCardToExport}
            onAddCardsToExport={handleAddCardsToExport}
            showNotification={showNotification}
            batchDefaults={batchDefaults}
            scannerExperiments={scannerExperiments}
            onUpdateScannerExperiments={(patch) => setScannerExperiments(previous => normalizeScannerExperiments({ ...previous, ...patch }))}
            scanMatching={scanMatching}
            textVerifier={textVerifier}
            cropRefiner={scannerExperiments.perspective ? refineCardCrop : null}
            autoScanEnabled={autoScan.autoScanEnabled}
            onToggleAutoScan={autoScan.toggleAutoScan}
            debugEnabled={debugEnabled}
            onDebugChange={handleDebugChange}
            scanOverlayEnabled={scanOverlayEnabled}
            onScanOverlayChange={setScanOverlayEnabled}
            debugCapture={debugCapture}
            scanRecording={scanRecording}
            onRetryDebugCapture={() => { if (lastDebugAcceptedRef.current) captureAcceptedDebugScan(lastDebugAcceptedRef.current); }}
            exportFormat={exportFormat}
            scanSetFilter={scanSetFilter}
            scanSetOptions={scanSetOptions}
            onUpdateScanSetFilter={setScanSetFilter}
            recentPendingScanEvents={recentPendingScanEvents}
            priceByCardId={priceByCardId}
            priceCurrency={priceCurrency}
            priceExchangeRates={priceExchangeRates}
          />
        )}

        {activeTab === 'collection' && (
          <CollectionTab
            scannedCards={scannedCards}
            onUpdateCard={handleUpdateCard}
            onRemoveCard={handleRemoveCard}
            onSplitCard={handleSplitCardVariant}
            onClearAll={handleClearAll}
            onExport={handleExport}
            exportFormat={exportFormat}
            onCopyDeckList={handleCopyDeckList}
            priceByCardId={priceByCardId}
            priceCurrency={priceCurrency}
            priceExchangeRates={priceExchangeRates}
          />
        )}

        {activeTab === 'settings' && (
          <SettingsTab
            onTestScanSound={async () => {
              const played = await scanSound.testSound();
              showNotification(played ? 'Test sound played' : 'Sound unavailable. Check your audio output and volume.', played ? 'success' : 'info');
            }}
            detectorMode={detection.detectorMode}
            onUpdateCardDatabase={handleUpdateCardDatabase}
            onUpdatePriceData={handleImportPriceSnapshot}
            maintenanceBusy={priceSyncBusy || cardDatabaseBusy || appUpdateBusy}
            appUpdateState={appUpdateState}
            onCheckAppUpdate={handleCheckAppUpdate}
            onInstallAppUpdate={handleInstallAppUpdate}
            cardDatabaseLabel={cardDatabaseSourceLabel}
            cardDatabaseUpdatedAt={cardDatabaseUpdatedAt}
            cardDatabaseSetCoverage={cardDatabaseSetCoverage}
            priceCacheLabel={priceSyncMeta?.requiresRefresh ? 'Refresh prices to apply corrected card matching' : priceSyncMeta
              ? `${priceSyncMeta.matchedRows}/${priceSyncMeta.totalRows} cards matched · FX ${priceExchangeRateDate}${priceSyncMeta.sourceHint ? ` · ${priceSyncMeta.sourceHint}` : ''}`
              : `${PRICE_SOURCE_LABEL} not imported yet`}
            priceCacheUpdatedAt={priceSyncMeta?.updatedAt || null}
            priceSourceDate={priceSyncMeta?.sourceNewestDate || null}
            storageInfo={runtimeInfo?.storage || null}
            onOpenStorageFolder={async (folder) => {
              try { await invokeDesktopCommand('open_storage_folder', { folder }); }
              catch (error) { showNotification(String(error?.message || error), 'error'); }
            }}
            priceExchangeRates={priceExchangeRates}
            priceExchangeRateDate={priceExchangeRateDate}
            priceExchangeRateFallback={priceExchangeRateFallback}
            cameraSettings={camera.settings}
            cameraDevices={cameraDevices}
            onRefreshCameraDevices={refreshCameraDevices}
            runtimeLabel={runtimeInfo ? `Desktop shell (${runtimeInfo.platform}/${runtimeInfo.arch})` : (isDesktopRuntime() ? 'Desktop shell' : 'Browser build')}
          />
        )}
      </div>

      {/* Bottom navigation */}
      <BottomTabBar
        activeTab={activeTab}
        onTabChange={setActiveTab}
        scannedCount={scannedCards.reduce((sum, c) => sum + c.quantity, 0)}
      />

      {scanAddAnimation && (
        <ScanAddAnimation
          key={scanAddAnimation.key}
          cardData={scanAddAnimation.cardData}
          priceRecord={scanAddAnimation.priceRecord}
          priceCurrency={priceCurrency}
          priceExchangeRates={priceExchangeRates}
        />
      )}

      {/* Toast */}
      <ToastNotification notification={notification} />

      {updateTask && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-rift-950/80 px-6 backdrop-blur-sm">
          <div className="w-full max-w-md rounded-3xl border border-gold-400/20 bg-rift-900/95 p-5 shadow-2xl shadow-black/30">
            <div className="flex items-center gap-4">
              <div className="h-12 w-12 animate-spin rounded-full border-4 border-gold-400/20 border-t-gold-400" />
              <div className="min-w-0 flex-1">
                <div className="text-sm font-semibold text-gold-300">
                  {updateTask.title}
                </div>
                <div className="mt-1 text-xs leading-relaxed text-rift-300">
                  {updateTask.detail}
                </div>
              </div>
            </div>
            <div className="mt-4 h-2 overflow-hidden rounded-full bg-rift-700">
              <div
                className="h-full rounded-full bg-gradient-to-r from-gold-500 to-gold-400 transition-all duration-300"
                style={{ width: `${Math.round(updateTask.progress * 100)}%` }}
              />
            </div>
            <div className="mt-2 text-right text-[10px] text-rift-500">
              {Math.round(updateTask.progress * 100)}%
            </div>
          </div>
        </div>
      )}
    </AppShell>
  );
}
