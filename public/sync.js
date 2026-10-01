// [Chronicler - IndexedDB & LocalStorage Cloudflare D1 Sync Bridge]

(function () {
  const DB_NAME = "chronicler"; // Chronicler가 사용하는 IndexedDB 이름

  // IndexedDB의 모든 데이터를 JSON으로 추출
  function exportIndexedDB() {
    return new Promise((resolve) => {
      const request = indexedDB.open(DB_NAME);
      request.onerror = () => resolve({});
      request.onsuccess = (event) => {
        const db = event.target.result;
        const storeNames = Array.from(db.objectStoreNames);
        if (storeNames.length === 0) return resolve({});

        const result = {};
        let completed = 0;

        storeNames.forEach((storeName) => {
          const transaction = db.transaction(storeName, "readonly");
          const store = transaction.objectStore(storeName);
          const getAllReq = store.getAll();

          getAllReq.onsuccess = () => {
            result[storeName] = getAllReq.result;
            completed++;
            if (completed === storeNames.length) resolve(result);
          };
          getAllReq.onerror = () => {
            completed++;
            if (completed === storeNames.length) resolve(result);
          };
        });
      };
    });
  }

  // D1에서 가져온 데이터를 IndexedDB에 복원
  function importIndexedDB(data) {
    return new Promise((resolve) => {
      if (!data || Object.keys(data).length === 0) return resolve(false);

      const request = indexedDB.open(DB_NAME);
      request.onerror = () => resolve(false);
      request.onsuccess = (event) => {
        const db = event.target.result;
        const storeNames = Array.from(db.objectStoreNames);
        if (storeNames.length === 0) return resolve(false);

        const transaction = db.transaction(storeNames, "readwrite");
        storeNames.forEach((storeName) => {
          if (data[storeName] && Array.isArray(data[storeName])) {
            const store = transaction.objectStore(storeName);
            store.clear(); // 기존 로컬 비우기
            data[storeName].forEach((item) => store.put(item));
          }
        });

        transaction.oncomplete = () => resolve(true);
        transaction.onerror = () => resolve(false);
      };
    });
  }

  // 1. 앱 실행 전 Cloudflare D1에서 최신 IndexedDB + LocalStorage 데이터 당겨오기
  async function syncFromCloud() {
    try {
      const res = await fetch("/api/mcp");
      if (res.ok) {
        const payload = await res.json();
        
        // IndexedDB 복원
        if (payload.idbData) {
          await importIndexedDB(payload.idbData);
        }

        // LocalStorage 복원
        if (payload.lsData) {
          Object.keys(payload.lsData).forEach((key) => {
            localStorage.setItem(key, payload.lsData[key]);
          });
        }

        console.log("✅ [D1 Sync Bridge] D1 클라우드 데이터(IndexedDB) 복원 완료");
      }
    } catch (err) {
      console.warn("⚠️ [D1 Sync Bridge] 동기화 실패 (오프라인 모드):", err);
    }
  }

  // 2. 브라우저 이탈 시 IndexedDB + LocalStorage를 백그라운드로 D1 백업
  async function syncToCloud() {
    try {
      const idbData = await exportIndexedDB();
      const lsData = {};
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key && key.startsWith("chronicler")) {
          lsData[key] = localStorage.getItem(key);
        }
      }

      if (Object.keys(idbData).length > 0 || Object.keys(lsData).length > 0) {
        const payload = JSON.stringify({ idbData, lsData });
        navigator.sendBeacon("/api/mcp", payload);
      }
    } catch (e) {
      // ignore
    }
  }

  // 실행
  syncFromCloud();
  window.addEventListener("beforeunload", syncToCloud);
  window.addEventListener("pagehide", syncToCloud);
})();
