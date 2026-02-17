// Bus Student Tracker Application
// Uses IndexedDB for primary storage with optional Firebase sync
// Bump APP_VERSION when you deploy; also update service-worker.js and manifest.json
const APP_VERSION = '1.0.8';

class BusStudentTracker {
    constructor() {
        this.db = null;
        this.dbName = 'BusStudentTrackerDB';
        this.dbVersion = 4; // Incremented to add routeRows store
        this.busses = [];
        this.students = [];
        this.routeRows = [];
        this.currentBusId = null;
        this.currentRoute = 'AM'; // 'AM' or 'PM'
        this.editingBusId = null;
        this.editingStudentId = null;
        this.selectedSeat = null; // {row: number, side: 'left'|'right', position: 0|1}
        this.firebaseEnabled = false;
        this.syncId = this.getOrCreateSyncId();
        this.checkins = [];
        this.encryptionKey = null; // Set when user enters password or loaded from storage
        this.ENCRYPTION_STORAGE_KEY = 'busTrackerEncryptionEnabled';
        this.ENCRYPTION_KEY_STORAGE_KEY = 'busTrackerEncryptionKey_' + this.syncId.replace(/\W/g, '_');
        this.ENCRYPTION_KEY_VERSION_STORAGE_KEY = 'busTrackerEncryptionKeyVersion_' + this.syncId.replace(/\W/g, '_');
        
        // Bus configuration: 16 rows, 3 seats per side per row (6 seats total per row)
        this.busConfig = {
            rows: 16,
            seatsPerSide: 3,
            totalSeatsPerRow: 6
        };
        
        // Initialize IndexedDB first
        this.initIndexedDB().then(() => {
            this.waitForFirebase(async () => {
                this.initializeFirebase();
                const encConfig = await this.getEncryptionConfigFromFirebase();
                if (encConfig.required) {
                    const storedKeyVersion = this.getStoredKeyVersion();
                    if (storedKeyVersion < encConfig.keyVersion) {
                        this.clearStoredEncryptionKey();
                    }
                    const storedKey = await this.loadEncryptionKeyFromStorage();
                    if (storedKey) {
                        this.encryptionKey = storedKey;
                        try {
                            await this.syncFromFirebase();
                        } catch (e) {
                            if (e.message === 'WRONG_PASSWORD') {
                                this.clearStoredEncryptionKey();
                                this.encryptionKey = null;
                                this.showEncryptionPasswordModal();
                                return;
                            }
                            throw e;
                        }
                        await this.loadData();
                        this.initializeApp();
                        return;
                    }
                    this.showEncryptionPasswordModal();
                    return;
                }
                try {
                    await this.syncFromFirebase();
                } catch (e) {
                    console.error('Sync error:', e);
                }
                this.loadData().then(() => this.initializeApp()).catch(error => {
                    console.error('Error loading data:', error);
                    this.initializeApp();
                });
            });
        });
    }

    // IndexedDB Setup
    async initIndexedDB() {
        return new Promise((resolve, reject) => {
            const request = indexedDB.open(this.dbName, this.dbVersion);
            
            request.onerror = () => {
                console.error('IndexedDB error:', request.error);
                reject(request.error);
            };
            
            request.onsuccess = () => {
                this.db = request.result;
                console.log('IndexedDB opened successfully');
                resolve();
            };
            
            request.onupgradeneeded = (event) => {
                const db = event.target.result;
                const transaction = event.target.transaction;
                
                // Create busses store
                if (!db.objectStoreNames.contains('busses')) {
                    const bussesStore = db.createObjectStore('busses', { keyPath: 'id', autoIncrement: false });
                    bussesStore.createIndex('name', 'name', { unique: false });
                }
                
                // Create students store
                if (!db.objectStoreNames.contains('students')) {
                    const studentsStore = db.createObjectStore('students', { keyPath: 'id', autoIncrement: false });
                    studentsStore.createIndex('name', 'name', { unique: false });
                    studentsStore.createIndex('grade', 'grade', { unique: false });
                }
                
                // Create or update seat assignments store
                let assignmentsStore;
                if (!db.objectStoreNames.contains('seatAssignments')) {
                    assignmentsStore = db.createObjectStore('seatAssignments', { keyPath: 'id', autoIncrement: false });
                    assignmentsStore.createIndex('busId', 'busId', { unique: false });
                    assignmentsStore.createIndex('studentId', 'studentId', { unique: false });
                    assignmentsStore.createIndex('row', 'row', { unique: false });
                    assignmentsStore.createIndex('route', 'route', { unique: false });
                    assignmentsStore.createIndex('busRoute', ['busId', 'route'], { unique: false });
                } else {
                    assignmentsStore = transaction.objectStore('seatAssignments');
                    // Add route indexes if they don't exist (for database upgrades)
                    if (!assignmentsStore.indexNames.contains('route')) {
                        assignmentsStore.createIndex('route', 'route', { unique: false });
                    }
                    if (!assignmentsStore.indexNames.contains('busRoute')) {
                        assignmentsStore.createIndex('busRoute', ['busId', 'route'], { unique: false });
                    }
                }
                
                // Create checkins store
                if (!db.objectStoreNames.contains('checkins')) {
                    const checkinsStore = db.createObjectStore('checkins', { keyPath: 'id', autoIncrement: false });
                    checkinsStore.createIndex('busId', 'busId', { unique: false });
                    checkinsStore.createIndex('studentId', 'studentId', { unique: false });
                    checkinsStore.createIndex('date', 'date', { unique: false });
                    checkinsStore.createIndex('route', 'route', { unique: false });
                    checkinsStore.createIndex('busDateRoute', ['busId', 'date', 'route'], { unique: false });
                    checkinsStore.createIndex('studentDate', ['studentId', 'date'], { unique: false });
                }
                
                // Create routeRows store (spreadsheet route stops)
                if (!db.objectStoreNames.contains('routeRows')) {
                    const routeRowsStore = db.createObjectStore('routeRows', { keyPath: 'id', autoIncrement: false });
                    routeRowsStore.createIndex('busId', 'busId', { unique: false });
                    routeRowsStore.createIndex('route', 'route', { unique: false });
                    routeRowsStore.createIndex('busRoute', ['busId', 'route'], { unique: false });
                }
                
                console.log('IndexedDB stores created');
            };
        });
    }

    // Generate unique ID
    generateId() {
        return Date.now().toString(36) + Math.random().toString(36).substr(2);
    }

    // Get sync ID - always uses the same shared ID for all instances
    getOrCreateSyncId() {
        // Fixed Sync ID - all instances use this same ID
        return 'qisd-bus-student-tracker';
    }

    // --- Client-side encryption (before syncing to Firebase) ---
    isEncryptionEnabled() {
        return localStorage.getItem(this.ENCRYPTION_STORAGE_KEY) === 'true';
    }

    setEncryptionEnabled(enabled) {
        if (enabled) localStorage.setItem(this.ENCRYPTION_STORAGE_KEY, 'true');
        else {
            localStorage.removeItem(this.ENCRYPTION_STORAGE_KEY);
            this.encryptionKey = null;
        }
    }

    async deriveEncryptionKey(password) {
        const encoder = new TextEncoder();
        const salt = encoder.encode('bus-tracker-enc-v1-' + this.syncId);
        const keyMaterial = await crypto.subtle.importKey(
            'raw',
            encoder.encode(password),
            'PBKDF2',
            false,
            ['deriveBits']
        );
        const bits = await crypto.subtle.deriveBits(
            { name: 'PBKDF2', salt, iterations: 310000, hash: 'SHA-256' },
            keyMaterial,
            256
        );
        return crypto.subtle.importKey('raw', bits, { name: 'AES-GCM' }, true, ['encrypt', 'decrypt']);
    }

    async saveEncryptionKeyToStorage(key, keyVersion = 1) {
        const raw = await crypto.subtle.exportKey('raw', key);
        const b64 = btoa(String.fromCharCode.apply(null, new Uint8Array(raw)));
        localStorage.setItem(this.ENCRYPTION_KEY_STORAGE_KEY, b64);
        localStorage.setItem(this.ENCRYPTION_KEY_VERSION_STORAGE_KEY, String(keyVersion));
    }

    getStoredKeyVersion() {
        const v = localStorage.getItem(this.ENCRYPTION_KEY_VERSION_STORAGE_KEY);
        return v ? parseInt(v, 10) : 0;
    }

    clearStoredEncryptionKey() {
        localStorage.removeItem(this.ENCRYPTION_KEY_STORAGE_KEY);
        localStorage.removeItem(this.ENCRYPTION_KEY_VERSION_STORAGE_KEY);
    }

    async loadEncryptionKeyFromStorage() {
        const b64 = localStorage.getItem(this.ENCRYPTION_KEY_STORAGE_KEY);
        if (!b64) return null;
        try {
            const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
            return await crypto.subtle.importKey('raw', bytes, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
        } catch (e) {
            this.clearStoredEncryptionKey();
            return null;
        }
    }

    async getEncryptionConfigFromFirebase() {
        if (!this.firebaseEnabled || !window.db) return { required: false, keyVersion: 0 };
        try {
            const doc = await window.db.collection('busTracker').doc(this.syncId).get();
            const data = doc.exists && doc.data() ? doc.data() : {};
            return {
                required: !!data.encryptionRequired,
                keyVersion: typeof data.encryptionKeyVersion === 'number' ? data.encryptionKeyVersion : (data.encryptionRequired ? 1 : 0)
            };
        } catch (e) {
            return { required: false, keyVersion: 0 };
        }
    }

    async getEncryptionRequiredFromFirebase() {
        const config = await this.getEncryptionConfigFromFirebase();
        return config.required;
    }

    async setEncryptionRequiredInFirebase(required, keyVersion = 1) {
        if (!this.firebaseEnabled || !window.db) return;
        const update = { encryptionRequired: !!required };
        if (required) update.encryptionKeyVersion = keyVersion;
        await window.db.collection('busTracker').doc(this.syncId).set(update, { merge: true });
    }

    async reEncryptAllWithNewKey(oldKey, newKey) {
        if (!this.firebaseEnabled || !window.db) return;
        const baseRef = window.db.collection('busTracker').doc(this.syncId);
        const collections = ['busses', 'students', 'seatAssignments', 'checkins', 'routeRows'];
        for (const collName of collections) {
            const snapshot = await baseRef.collection(collName).get();
            for (const doc of snapshot.docs) {
                const data = doc.data();
                if (!data || data.v !== 1 || !data.enc) continue;
                const combined = Uint8Array.from(atob(data.enc), c => c.charCodeAt(0));
                const iv = combined.slice(0, 12);
                const ciphertext = combined.slice(12);
                let decrypted;
                try {
                    decrypted = await crypto.subtle.decrypt(
                        { name: 'AES-GCM', iv, tagLength: 128 },
                        oldKey,
                        ciphertext
                    );
                } catch (e) {
                    throw new Error('WRONG_PASSWORD');
                }
                const decoded = JSON.parse(new TextDecoder().decode(decrypted));
                if (decoded.id !== doc.id) decoded.id = doc.id;
                const prevKey = this.encryptionKey;
                this.encryptionKey = newKey;
                const payload = await this.encryptForSync(decoded);
                this.encryptionKey = prevKey;
                await baseRef.collection(collName).doc(doc.id).set(payload);
            }
        }
    }

    async changeEncryptionPassword(currentPassword, newPassword) {
        const oldKey = await this.deriveEncryptionKey(currentPassword.trim());
        const newKey = await this.deriveEncryptionKey(newPassword.trim());
        await this.reEncryptAllWithNewKey(oldKey, newKey);
        const config = await this.getEncryptionConfigFromFirebase();
        const nextVersion = (config.keyVersion || 1) + 1;
        await this.setEncryptionRequiredInFirebase(true, nextVersion);
        this.encryptionKey = newKey;
        await this.saveEncryptionKeyToStorage(newKey, nextVersion);
    }

    async encryptForSync(data) {
        if (!this.encryptionKey) return data;
        const encoder = new TextEncoder();
        const iv = crypto.getRandomValues(new Uint8Array(12));
        const plaintext = encoder.encode(JSON.stringify(data));
        const ciphertext = await crypto.subtle.encrypt(
            { name: 'AES-GCM', iv, tagLength: 128 },
            this.encryptionKey,
            plaintext
        );
        const combined = new Uint8Array(iv.length + ciphertext.byteLength);
        combined.set(iv, 0);
        combined.set(new Uint8Array(ciphertext), iv.length);
        return { enc: btoa(String.fromCharCode.apply(null, combined)), v: 1 };
    }

    async decryptFromSync(docId, docData) {
        if (!docData || docData.v !== 1 || !docData.enc) return docData;
        if (!this.encryptionKey) return null;
        try {
            const combined = Uint8Array.from(atob(docData.enc), c => c.charCodeAt(0));
            const iv = combined.slice(0, 12);
            const ciphertext = combined.slice(12);
            const decrypted = await crypto.subtle.decrypt(
                { name: 'AES-GCM', iv, tagLength: 128 },
                this.encryptionKey,
                ciphertext
            );
            const decoded = JSON.parse(new TextDecoder().decode(decrypted));
            if (decoded.id !== docId) decoded.id = docId;
            return decoded;
        } catch (e) {
            console.error('Decryption failed:', e);
            return null;
        }
    }

    // Wait for Firebase to be ready
    waitForFirebase(callback) {
        if (window.location.protocol === 'file:') {
            console.log('Running from file:// - Firebase disabled');
            callback();
            return;
        }
        
        if (window.db) {
            callback();
        } else {
            window.addEventListener('firebaseReady', callback, { once: true });
            // Timeout after 5 seconds
            setTimeout(() => {
                console.warn('Firebase not ready after 5 seconds, continuing without it');
                callback();
            }, 5000);
        }
    }

    // Initialize Firebase (does not sync yet; sync runs after encryption check)
    initializeFirebase() {
        if (window.location.protocol === 'file:') {
            console.log('Running from file:// - Firebase disabled');
            return;
        }
        if (window.db) {
            this.firebaseEnabled = true;
            console.log('Firebase enabled');
            this.setupRealtimeListeners();
        } else {
            console.log('Firebase not available');
        }
    }

    // Setup real-time listeners for multi-user sync
    setupRealtimeListeners() {
        if (!this.firebaseEnabled || !window.db) return;
        
        // Remove any existing listeners
        if (this.busListener) this.busListener();
        if (this.studentListener) this.studentListener();
        if (this.assignmentListener) this.assignmentListener();
        
        const baseRef = window.db.collection('busTracker').doc(this.syncId);
        
        // Listen for bus changes
        this.busListener = baseRef.collection('busses').onSnapshot(async (snapshot) => {
            for (const change of snapshot.docChanges()) {
                if (change.type === 'added' || change.type === 'modified') {
                    const bus = await this.decryptFromSync(change.doc.id, change.doc.data());
                    if (bus) await this.addBusToIndexedDB(bus);
                    this.renderBusses();
                } else if (change.type === 'removed') {
                    const busId = change.doc.id;
                    this.busses = this.busses.filter(b => b.id !== busId);
                    this.renderBusses();
                    if (this.currentBusId === busId) this.showMainScreen();
                }
            }
        }, (error) => {
            console.error('Bus listener error:', error);
        });
        
        // Listen for student changes
        this.studentListener = baseRef.collection('students').onSnapshot(async (snapshot) => {
            for (const change of snapshot.docChanges()) {
                if (change.type === 'added' || change.type === 'modified') {
                    const student = await this.decryptFromSync(change.doc.id, change.doc.data());
                    if (student) this.addStudentToIndexedDB(student);
                } else if (change.type === 'removed') {
                    const studentId = change.doc.id;
                    this.students = this.students.filter(s => s.id !== studentId);
                }
            }
        }, (error) => {
            console.error('Student listener error:', error);
        });
        
        // Listen for seat assignment changes
        this.assignmentListener = baseRef.collection('seatAssignments').onSnapshot(async (snapshot) => {
            for (const change of snapshot.docChanges()) {
                if (change.type === 'added' || change.type === 'modified') {
                    const assignment = await this.decryptFromSync(change.doc.id, change.doc.data());
                    if (assignment) {
                        await this.addSeatAssignmentToIndexedDB(assignment);
                        if (this.currentBusId === assignment.busId) this.renderBusDiagram();
                    }
                } else if (change.type === 'removed') {
                    const assignmentId = change.doc.id;
                    const transaction = this.db.transaction(['seatAssignments'], 'readwrite');
                    const store = transaction.objectStore('seatAssignments');
                    store.delete(assignmentId).onsuccess = () => {
                        if (this.currentBusId) this.renderBusDiagram();
                    };
                }
            }
        }, (error) => {
            console.error('Assignment listener error:', error);
        });
        
        // Listen for checkin changes
        this.checkinListener = baseRef.collection('checkins').onSnapshot(async (snapshot) => {
            for (const change of snapshot.docChanges()) {
                if (change.type === 'added' || change.type === 'modified') {
                    const checkin = await this.decryptFromSync(change.doc.id, change.doc.data());
                    if (checkin) this.addCheckinToIndexedDB(checkin);
                } else if (change.type === 'removed') {
                    const checkinId = change.doc.id;
                    this.checkins = this.checkins.filter(c => c.id !== checkinId);
                }
            }
        }, (error) => {
            console.error('Checkin listener error:', error);
        });
        
        // Listen for routeRow changes
        this.routeRowListener = baseRef.collection('routeRows').onSnapshot(async (snapshot) => {
            for (const change of snapshot.docChanges()) {
                if (change.type === 'added' || change.type === 'modified') {
                    const row = await this.decryptFromSync(change.doc.id, change.doc.data());
                    if (row) this.addRouteRowToIndexedDB(row);
                } else if (change.type === 'removed') {
                    const rowId = change.doc.id;
                    this.routeRows = this.routeRows.filter(r => r.id !== rowId);
                }
            }
        }, (error) => {
            console.error('RouteRow listener error:', error);
        });
        
        console.log('Real-time sync listeners established for sync ID:', this.syncId);
    }

    // Sync to Firebase (encrypts document if encryption is enabled)
    async syncToFirebase(collection, data, deleteId = null) {
        if (!this.firebaseEnabled || !window.db) return;
        
        try {
            const collectionRef = window.db.collection('busTracker').doc(this.syncId).collection(collection);
            
            if (deleteId) {
                await collectionRef.doc(deleteId).delete();
            } else if (data) {
                const payload = this.encryptionKey ? await this.encryptForSync(data) : data;
                await collectionRef.doc(data.id).set(payload);
            }
        } catch (error) {
            console.error('Firebase sync error:', error);
        }
    }

    // Sync from Firebase (decrypts documents when encryption is enabled)
    async syncFromFirebase() {
        if (!this.firebaseEnabled || !window.db) return;
        
        try {
            const decrypt = async (doc) => {
                const data = doc.data();
                const decrypted = await this.decryptFromSync(doc.id, data);
                if (decrypted === null && data && data.v === 1) throw new Error('WRONG_PASSWORD');
                return decrypted || data;
            };

            // Sync busses
            const bussesSnapshot = await window.db.collection('busTracker').doc(this.syncId).collection('busses').get();
            for (const doc of bussesSnapshot.docs) {
                const bus = await decrypt(doc);
                if (bus) this.addBusToIndexedDB(bus);
            }
            
            // Sync students
            const studentsSnapshot = await window.db.collection('busTracker').doc(this.syncId).collection('students').get();
            for (const doc of studentsSnapshot.docs) {
                const student = await decrypt(doc);
                if (student) this.addStudentToIndexedDB(student);
            }
            
            // Sync seat assignments
            const assignmentsSnapshot = await window.db.collection('busTracker').doc(this.syncId).collection('seatAssignments').get();
            for (const doc of assignmentsSnapshot.docs) {
                const assignment = await decrypt(doc);
                if (assignment) this.addSeatAssignmentToIndexedDB(assignment);
            }
            
            // Sync checkins
            const checkinsSnapshot = await window.db.collection('busTracker').doc(this.syncId).collection('checkins').get();
            for (const doc of checkinsSnapshot.docs) {
                const checkin = await decrypt(doc);
                if (checkin) this.addCheckinToIndexedDB(checkin);
            }
            
            // Sync routeRows
            const routeRowsSnapshot = await window.db.collection('busTracker').doc(this.syncId).collection('routeRows').get();
            for (const doc of routeRowsSnapshot.docs) {
                const row = await decrypt(doc);
                if (row) this.addRouteRowToIndexedDB(row);
            }
            
            // Reload UI
            await this.loadData();
            this.renderBusses();
            if (this.currentBusId) await this.renderBusDiagram();
        } catch (error) {
            if (error.message === 'WRONG_PASSWORD') throw error;
            console.error('Firebase sync error:', error);
        }
    }

    // IndexedDB CRUD Operations - Busses
    async addBusToIndexedDB(bus) {
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction(['busses'], 'readwrite');
            const store = transaction.objectStore('busses');
            const request = store.put(bus);
            
            request.onsuccess = () => {
                const index = this.busses.findIndex(b => b.id === bus.id);
                if (index === -1) {
                    this.busses.push(bus);
                } else {
                    this.busses[index] = bus;
                }
                resolve(bus);
            };
            
            request.onerror = () => {
                reject(request.error);
            };
        });
    }

    async addBus(bus) {
        bus.id = bus.id || this.generateId();
        bus.createdAt = new Date().toISOString();
        await this.addBusToIndexedDB(bus);
        this.syncToFirebase('busses', bus);
        return bus;
    }

    async updateBus(bus) {
        await this.addBusToIndexedDB(bus);
        this.syncToFirebase('busses', bus);
        return bus;
    }

    async deleteBus(busId) {
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction(['busses', 'seatAssignments'], 'readwrite');
            const busStore = transaction.objectStore('busses');
            const assignmentStore = transaction.objectStore('seatAssignments');
            const busRequest = busStore.delete(busId);
            
            busRequest.onsuccess = () => {
                // Delete all seat assignments for this bus
                const assignmentIndex = assignmentStore.index('busId');
                const range = IDBKeyRange.only(busId);
                const cursorRequest = assignmentIndex.openCursor(range);
                
                cursorRequest.onsuccess = (e) => {
                    const cursor = e.target.result;
                    if (cursor) {
                        assignmentStore.delete(cursor.primaryKey);
                        cursor.continue();
                    } else {
                        this.busses = this.busses.filter(b => b.id !== busId);
                        this.syncToFirebase('busses', null, busId);
                        resolve();
                    }
                };
            };
            
            busRequest.onerror = () => {
                reject(busRequest.error);
            };
        });
    }

    // IndexedDB CRUD Operations - Students
    async addStudentToIndexedDB(student) {
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction(['students'], 'readwrite');
            const store = transaction.objectStore('students');
            const request = store.put(student);
            
            request.onsuccess = () => {
                const index = this.students.findIndex(s => s.id === student.id);
                if (index === -1) {
                    this.students.push(student);
                } else {
                    this.students[index] = student;
                }
                resolve(student);
            };
            
            request.onerror = () => {
                reject(request.error);
            };
        });
    }

    async addStudent(student) {
        student.id = student.id || this.generateId();
        await this.addStudentToIndexedDB(student);
        this.syncToFirebase('students', student);
        return student;
    }

    async updateStudent(student) {
        await this.addStudentToIndexedDB(student);
        this.syncToFirebase('students', student);
        return student;
    }

    async deleteStudent(studentId) {
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction(['students', 'seatAssignments'], 'readwrite');
            const studentStore = transaction.objectStore('students');
            const assignmentStore = transaction.objectStore('seatAssignments');
            const studentRequest = studentStore.delete(studentId);
            
            studentRequest.onsuccess = () => {
                // Delete all seat assignments for this student
                const assignmentIndex = assignmentStore.index('studentId');
                const range = IDBKeyRange.only(studentId);
                const cursorRequest = assignmentIndex.openCursor(range);
                
                cursorRequest.onsuccess = (e) => {
                    const cursor = e.target.result;
                    if (cursor) {
                        assignmentStore.delete(cursor.primaryKey);
                        cursor.continue();
                    } else {
                        this.students = this.students.filter(s => s.id !== studentId);
                        this.syncToFirebase('students', null, studentId);
                        resolve();
                    }
                };
            };
            
            studentRequest.onerror = () => {
                reject(studentRequest.error);
            };
        });
    }

    // IndexedDB CRUD Operations - Seat Assignments
    async getSeatAssignments(busId, route = null) {
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction(['seatAssignments'], 'readonly');
            const store = transaction.objectStore('seatAssignments');
            
            let request;
            if (route) {
                // Get assignments for specific bus and route
                const index = store.index('busRoute');
                const key = [busId, route];
                const range = IDBKeyRange.only(key);
                request = index.getAll(range);
            } else {
                // Get all assignments for bus (backward compatibility)
                const index = store.index('busId');
                const range = IDBKeyRange.only(busId);
                request = index.getAll(range);
            }
            
            request.onsuccess = () => {
                resolve(request.result || []);
            };
            
            request.onerror = () => {
                reject(request.error);
            };
        });
    }

    async addSeatAssignmentToIndexedDB(assignment) {
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction(['seatAssignments'], 'readwrite');
            const store = transaction.objectStore('seatAssignments');
            const request = store.put(assignment);
            
            request.onsuccess = () => {
                resolve(assignment);
            };
            
            request.onerror = () => {
                reject(request.error);
            };
        });
    }

    async assignStudentToSeat(busId, studentId, row, side, position, route) {
        // Remove any existing assignment for this seat on this route
        await this.unassignSeat(busId, row, side, position, route);
        
        // Remove any existing assignment for this student on this bus and route
        const assignments = await this.getSeatAssignments(busId, route);
        if (assignments) {
            const existingAssignment = assignments.find(a => a.studentId === studentId);
            if (existingAssignment) {
                await this.unassignSeat(busId, existingAssignment.row, existingAssignment.side, existingAssignment.position, route);
            }
        }
        
        const assignment = {
            id: this.generateId(),
            busId: busId,
            route: route || 'AM', // Default to AM for backward compatibility
            studentId: studentId,
            row: row,
            side: side,
            position: position,
            assignedAt: new Date().toISOString()
        };
        
        await this.addSeatAssignmentToIndexedDB(assignment);
        this.syncToFirebase('seatAssignments', assignment);
        return assignment;
    }

    async unassignSeat(busId, row, side, position, route) {
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction(['seatAssignments'], 'readwrite');
            const store = transaction.objectStore('seatAssignments');
            const routeToUse = route || this.currentRoute || 'AM';
            const index = store.index('busRoute');
            const key = [busId, routeToUse];
            const range = IDBKeyRange.only(key);
            const request = index.openCursor(range);
            
            request.onsuccess = (e) => {
                const cursor = e.target.result;
                if (cursor) {
                    const assignment = cursor.value;
                    if (assignment.row === row && assignment.side === side && assignment.position === position) {
                        store.delete(cursor.primaryKey);
                        this.syncToFirebase('seatAssignments', null, assignment.id);
                    }
                    cursor.continue();
                } else {
                    resolve();
                }
            };
            
            request.onerror = () => {
                reject(request.error);
            };
        });
    }

    async getStudentAtSeat(busId, row, side, position, route) {
        const routeToUse = route || this.currentRoute || 'AM';
        const assignments = await this.getSeatAssignments(busId, routeToUse);
        const assignment = assignments.find(a => 
            a.row === row && a.side === side && a.position === position
        );
        
        if (assignment) {
            return this.students.find(s => s.id === assignment.studentId);
        }
        return null;
    }

    // Load data from IndexedDB
    async loadData() {
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction(['busses', 'students', 'seatAssignments', 'checkins', 'routeRows'], 'readonly');
            
            // Load busses
            const busStore = transaction.objectStore('busses');
            const busRequest = busStore.getAll();
            
            busRequest.onsuccess = () => {
                this.busses = busRequest.result || [];
                
                // Load students
                const studentStore = transaction.objectStore('students');
                const studentRequest = studentStore.getAll();
                
                studentRequest.onsuccess = () => {
                    this.students = studentRequest.result || [];
                    
                    // Load checkins
                    const checkinStore = transaction.objectStore('checkins');
                    const checkinRequest = checkinStore.getAll();
                    
                    checkinRequest.onsuccess = () => {
                        this.checkins = checkinRequest.result || [];
                        
                        // Load routeRows
                        const routeRowStore = transaction.objectStore('routeRows');
                        const routeRowRequest = routeRowStore.getAll();
                        routeRowRequest.onsuccess = () => {
                            this.routeRows = routeRowRequest.result || [];
                            resolve();
                        };
                        routeRowRequest.onerror = () => {
                            reject(routeRowRequest.error);
                        };
                    };
                    
                    checkinRequest.onerror = () => {
                        reject(checkinRequest.error);
                    };
                };
                
                studentRequest.onerror = () => {
                    reject(studentRequest.error);
                };
            };
            
            busRequest.onerror = () => {
                reject(busRequest.error);
            };
        });
    }

    // Initialize App UI
    initializeApp() {
        this.setupEventListeners();
        this.renderBusses();
        const versionEl = document.getElementById('versionText');
        if (versionEl) versionEl.textContent = 'App Version: ' + APP_VERSION;
        this.checkForUpdates();
        this.checkFirebaseVersion();
        this.updateSyncStatus();
    }

    // Setup Event Listeners
    setupEventListeners() {
        // Bus list screen
        document.getElementById('createBusBtn').addEventListener('click', () => this.openBusModal());
        document.getElementById('studentsBtn').addEventListener('click', () => this.openStudentManagementModal());
        
        // Bus modal
        document.getElementById('closeBusModal').addEventListener('click', () => this.closeBusModal());
        document.getElementById('busForm').addEventListener('submit', (e) => {
            e.preventDefault();
            this.saveBus();
        });
        document.getElementById('deleteBusBtn').addEventListener('click', () => this.deleteCurrentBus());
        
        // Bus view screen
        document.getElementById('backToMainBtn').addEventListener('click', () => this.showMainScreen());
        document.getElementById('busSettingsBtn').addEventListener('click', () => this.openSettingsModal());
        document.getElementById('checkinBtn').addEventListener('click', () => this.openCheckinModal());
        document.getElementById('routeBtn').addEventListener('click', () => this.openRouteModal());
        
        // Main screen settings button
        document.getElementById('mainSettingsBtn').addEventListener('click', () => this.openSettingsModal());
        
        // Check-in modal
        document.getElementById('closeCheckinModal').addEventListener('click', () => this.closeCheckinModal());
        document.getElementById('closeRouteModal').addEventListener('click', () => this.closeRouteModal());
        document.getElementById('routeEditBtn').addEventListener('click', () => { this.routeModalEditMode = true; this.updateRouteModalViewEditButtons(); this.renderRouteTable(); });
        document.getElementById('routeViewBtn').addEventListener('click', () => { this.routeModalEditMode = false; this.updateRouteModalViewEditButtons(); this.renderRouteTable(); });
        document.getElementById('routeAddRowBtn').addEventListener('click', () => this.addRouteModalRow());
        this.setupRouteTableListenersOnce();
        document.getElementById('viewCheckinHistoryBtn').addEventListener('click', () => this.openCheckinHistoryModal());
        document.getElementById('checkinStudentSearchInput').addEventListener('input', (e) => this.filterCheckinStudents(e.target.value));
        document.getElementById('addCheckinStudentBtn').addEventListener('click', () => this.addExtraCheckinStudent());
        
        // Check-in history modal
        document.getElementById('closeCheckinHistoryModal').addEventListener('click', () => this.closeCheckinHistoryModal());
        document.getElementById('loadCheckinHistoryBtn').addEventListener('click', () => this.loadCheckinHistory());
        document.getElementById('exportCheckinPDFBtn').addEventListener('click', () => this.exportCheckinToPDF());
        document.getElementById('exportCheckinExcelBtn').addEventListener('click', () => this.exportCheckinToExcel());
        
        // Student search modal
        document.getElementById('closeStudentSearchModal').addEventListener('click', () => this.closeStudentSearchModal());
        document.getElementById('studentSearchInput').addEventListener('input', (e) => this.filterStudents(e.target.value));
        document.getElementById('addNewStudentBtn').addEventListener('click', () => this.openStudentModal());
        
        // Student modal
        document.getElementById('closeStudentModal').addEventListener('click', () => this.closeStudentModal());
        document.getElementById('studentForm').addEventListener('submit', (e) => {
            e.preventDefault();
            this.saveStudent();
        });
        document.getElementById('deleteStudentBtn').addEventListener('click', () => this.deleteCurrentStudent());
        document.getElementById('addStudentRowBtn').addEventListener('click', () => this.addStudentNameRow());
        document.getElementById('studentNameRowsContainer').addEventListener('click', (e) => {
            if (e.target.classList.contains('remove-student-row-btn')) {
                this.removeStudentNameRow(e.target.closest('.student-name-row'));
            }
        });
        
        // Student info modal
        document.getElementById('closeStudentInfoModal').addEventListener('click', () => this.closeStudentInfoModal());
        document.getElementById('unassignStudentBtn').addEventListener('click', () => this.unassignCurrentStudent());
        
        // Settings modal
        document.getElementById('closeSettingsModal').addEventListener('click', () => this.closeSettingsModal());
        document.getElementById('manualSyncBtn').addEventListener('click', () => this.manualSync());
        document.getElementById('exportBackupBtn').addEventListener('click', () => this.exportAllData());
        document.getElementById('backupImportFileInput').addEventListener('change', (e) => {
            const file = e.target.files[0];
            if (file) this.importFromBackup(file);
        });
        document.getElementById('encryptionPasswordSubmitBtn').addEventListener('click', () => {
            this.handleEncryptionUnlock(document.getElementById('encryptionPasswordInput').value);
        });
        document.getElementById('encryptionPasswordInput').addEventListener('keydown', (e) => {
            if (e.key === 'Enter') this.handleEncryptionUnlock(e.target.value);
        });
        document.getElementById('encryptionEnabledCheckbox').addEventListener('change', async (e) => {
            if (!e.target.checked) {
                this.setEncryptionEnabled(false);
                localStorage.removeItem(this.ENCRYPTION_KEY_STORAGE_KEY);
                this.encryptionKey = null;
                await this.setEncryptionRequiredInFirebase(false);
            }
            this.updateEncryptionSettingsUI();
        });
        document.getElementById('encryptionSetPasswordBtn').addEventListener('click', () => this.enableEncryptionWithPassword());
        document.getElementById('encryptionChangePasswordBtn').addEventListener('click', () => this.changeEncryptionPasswordSubmit());
        document.getElementById('checkUpdateBtn').addEventListener('click', () => this.checkForUpdates(true));
        
        // Update banner
        document.getElementById('updateNowBtn').addEventListener('click', () => this.updateApp());
        document.getElementById('updateLaterBtn').addEventListener('click', () => {
            document.getElementById('updateBanner').classList.add('hidden');
        });
        
        // Click outside modals to close
        window.addEventListener('click', (e) => {
            const modals = ['busModal', 'studentSearchModal', 'studentInfoModal', 'studentModal', 'settingsModal', 'checkinModal', 'checkinHistoryModal', 'routeModal'];
            modals.forEach(modalId => {
                const modal = document.getElementById(modalId);
                if (e.target === modal) {
                    this.closeModal(modalId);
                }
            });
        });
    }

    // Screen Management
    showMainScreen() {
        document.getElementById('mainScreen').classList.add('active');
        document.getElementById('busScreen').classList.remove('active');
        this.currentBusId = null;
        this.renderBusses();
    }

    showBusScreen(busId, route = 'AM') {
        this.currentBusId = busId;
        this.currentRoute = route;
        document.getElementById('mainScreen').classList.remove('active');
        document.getElementById('busScreen').classList.add('active');
        
        const bus = this.busses.find(b => b.id === busId);
        if (bus) {
            document.getElementById('busNameHeader').textContent = bus.name;
            document.getElementById('busSubtitle').textContent = `${route} Route - Seating Assignment`;
        }
        
        this.renderBusDiagram().then(() => {
            // Scroll to bottom to show driver and row 1
            setTimeout(() => {
                const diagramContainer = document.getElementById('busDiagram');
                if (diagramContainer) {
                    diagramContainer.scrollIntoView({ behavior: 'smooth', block: 'end' });
                    // Also scroll the parent container
                    const busDiagramContainer = document.querySelector('.bus-diagram-container');
                    if (busDiagramContainer) {
                        busDiagramContainer.scrollTop = busDiagramContainer.scrollHeight;
                    }
                }
            }, 100);
        });
    }

    // Render Functions
    renderBusses() {
        const container = document.getElementById('bussesList');
        const emptyState = document.getElementById('emptyBussesState');
        
        if (this.busses.length === 0) {
            container.style.display = 'none';
            emptyState.style.display = 'block';
            return;
        }
        
        container.style.display = 'block';
        emptyState.style.display = 'none';
        
        // Sort busses by number (extract number from "Bus X" format)
        const sortedBusses = [...this.busses].sort((a, b) => {
            const numA = parseInt(a.name.replace(/^Bus\s+/i, '')) || 0;
            const numB = parseInt(b.name.replace(/^Bus\s+/i, '')) || 0;
            return numA - numB;
        });
        
        container.innerHTML = sortedBusses.map(bus => {
            return `
                <div class="bus-card">
                    <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px;">
                        <div class="bus-name">${this.escapeHtml(bus.name)}</div>
                        <button class="delete-bus-btn" onclick="event.stopPropagation(); app.deleteBusConfirm('${bus.id}')" title="Delete Bus">×</button>
                    </div>
                    <div class="bus-routes">
                        <button class="btn btn-primary" onclick="app.showBusScreen('${bus.id}', 'AM')">AM Route</button>
                        <button class="btn btn-primary" onclick="app.showBusScreen('${bus.id}', 'PM')">PM Route</button>
                    </div>
                </div>
            `;
        }).join('');
    }

    async renderBusDiagram() {
        const container = document.getElementById('busDiagram');
        const busId = this.currentBusId;
        const route = this.currentRoute || 'AM';
        
        if (!busId) return Promise.resolve();
        
        const assignments = await this.getSeatAssignments(busId, route);
        const assignmentMap = {};
        if (assignments) {
            assignments.forEach(a => {
                const key = `${a.row}-${a.side}-${a.position}`;
                assignmentMap[key] = a.studentId;
            });
        }
        
        let html = '';
        
        // Generate bus rows of seats (row 1 is closest to driver at bottom, last row is at back)
        for (let displayRow = this.busConfig.rows; displayRow >= 1; displayRow--) {
            const row = displayRow; // Row number (1 to busConfig.rows, where 1 is closest to driver)
            html += `<div class="bus-row" data-row-number="${row}">`;
            
            // Left side seats (3 seats) - these are seats 1, 2, and 3
            html += '<div class="seat-group left">';
            for (let pos = 0; pos < this.busConfig.seatsPerSide; pos++) {
                const seatNumber = pos + 1; // Seat 1, 2, or 3
                const key = `${row}-left-${pos}`;
                const studentId = assignmentMap[key];
                const student = studentId ? this.students.find(s => s.id === studentId) : null;
                const seatClass = student ? 'occupied' : '';
                const studentName = student ? (student.firstName || student.name || '').split(' ')[0] : '';
                const seatLabel = studentName ? this.escapeHtml(studentName) : '';
                
                html += `
                    <div class="seat ${seatClass}" 
                         data-row="${row}" 
                         data-side="left" 
                         data-position="${pos}"
                         onclick="app.handleSeatClick(${row}, 'left', ${pos})">
                        <div class="seat-name">${seatLabel}</div>
                        <div class="seat-label">Row ${row}-${seatNumber}</div>
                    </div>
                `;
            }
            html += '</div>';
            
            // Right side seats (3 seats) - these are seats 4, 5, and 6
            html += '<div class="seat-group right">';
            for (let pos = 0; pos < this.busConfig.seatsPerSide; pos++) {
                const seatNumber = pos + 4; // Seat 4, 5, or 6
                const key = `${row}-right-${pos}`;
                const studentId = assignmentMap[key];
                const student = studentId ? this.students.find(s => s.id === studentId) : null;
                const seatClass = student ? 'occupied' : '';
                const studentName = student ? (student.firstName || student.name || '').split(' ')[0] : '';
                const seatLabel = studentName ? this.escapeHtml(studentName) : '';
                
                html += `
                    <div class="seat ${seatClass}" 
                         data-row="${row}" 
                         data-side="right" 
                         data-position="${pos}"
                         onclick="app.handleSeatClick(${row}, 'right', ${pos})">
                        <div class="seat-name">${seatLabel}</div>
                        <div class="seat-label">Row ${row}-${seatNumber}</div>
                    </div>
                `;
            }
            html += '</div>';
            
            html += '</div>';
        }
        
        // Add driver seat directly under row 1-6 (rightmost seat of row 1)
        // Right side has 3 seats: seat 1-4 (pos 0), seat 1-5 (pos 1), seat 1-6 (pos 2)
        // To align driver with seat 1-6, we need to match the structure: 2 empty seats + gaps, then driver
        html += `
            <div class="bus-row driver-row">
                <div class="seat-group left"></div>
                <div class="seat-group right driver-seat-group">
                    <div class="seat" style="visibility: hidden; pointer-events: none;"></div>
                    <div class="seat" style="visibility: hidden; pointer-events: none;"></div>
                    <div class="seat driver">
                        <div class="seat-name">DRIVER</div>
                    </div>
                </div>
            </div>
        `;
        
        container.innerHTML = html;
    }

    // Seat Click Handler
    async handleSeatClick(row, side, position) {
        this.selectedSeat = { row, side, position };
        const busId = this.currentBusId;
        const route = this.currentRoute || 'AM';
        
        const student = await this.getStudentAtSeat(busId, row, side, position, route);
        
        if (student) {
            // Show student info modal
            this.showStudentInfoModal(student);
        } else {
            // Show student search modal
            this.showStudentSearchModal();
        }
    }

    // Student Search Modal
    showStudentSearchModal() {
        document.getElementById('studentSearchModalTitle').textContent = 'Select Student';
        document.getElementById('studentSearchModal').style.display = 'block';
        document.getElementById('studentSearchInput').value = '';
        // Don't show students until search is entered
        document.getElementById('studentsList').style.display = 'none';
        document.getElementById('emptyStudentsState').style.display = 'none';
        const searchInput = document.getElementById('studentSearchInput');
        if (searchInput) setTimeout(() => searchInput.focus(), 0);
    }

    openStudentManagementModal() {
        document.getElementById('studentSearchModalTitle').textContent = 'Manage Students';
        document.getElementById('studentSearchModal').style.display = 'block';
        document.getElementById('studentSearchInput').value = '';
        // Don't show students until search is entered
        document.getElementById('studentsList').style.display = 'none';
        document.getElementById('emptyStudentsState').style.display = 'none';
        // Clear selected seat so we know we're in management mode
        this.selectedSeat = null;
    }

    closeStudentSearchModal() {
        document.getElementById('studentSearchModal').style.display = 'none';
    }

    filterStudents(searchTerm) {
        const container = document.getElementById('studentsList');
        const emptyState = document.getElementById('emptyStudentsState');
        const term = searchTerm.trim().toLowerCase();
        
        // Don't show anything if search is empty
        if (!term) {
            container.style.display = 'none';
            emptyState.style.display = 'none';
            return;
        }
        
        // Only search first and last name
        const filtered = this.students.filter(student => {
            const firstName = (student.firstName || '').toLowerCase();
            const lastName = (student.lastName || '').toLowerCase();
            // Also check the name field for backward compatibility
            const name = (student.name || '').toLowerCase();
            
            return firstName.includes(term) || 
                   lastName.includes(term) ||
                   name.includes(term);
        });
        
        if (filtered.length === 0) {
            container.style.display = 'none';
            emptyState.style.display = 'block';
            return;
        }
        
        container.style.display = 'block';
        emptyState.style.display = 'none';
        
        container.innerHTML = filtered.map(student => {
            const displayName = student.firstName && student.lastName 
                ? `${student.firstName} ${student.lastName}`
                : student.name || 'Unknown';
            return `
                <div class="student-item" onclick="app.selectStudent('${student.id}')">
                    <div class="student-name">${this.escapeHtml(displayName)}</div>
                    <div class="student-meta">
                        ${student.grade ? `Grade ${student.grade}` : ''}
                    </div>
                </div>
            `;
        }).join('');
    }

    async selectStudent(studentId) {
        // If we have a selected seat, assign student to that seat
        if (this.selectedSeat && this.currentBusId) {
            const { row, side, position } = this.selectedSeat;
            const route = this.currentRoute || 'AM';
            await this.assignStudentToSeat(this.currentBusId, studentId, row, side, position, route);
            
            this.closeStudentSearchModal();
            this.renderBusDiagram();
            this.selectedSeat = null;
        } else {
            // Otherwise, open student modal for viewing/editing
            this.openStudentModal(studentId);
            this.closeStudentSearchModal();
        }
    }

    // Student Info Modal
    async showStudentInfoModal(student) {
        const displayName = student.firstName && student.lastName 
            ? `${student.firstName} ${student.lastName}`
            : student.name || 'Unknown';
        document.getElementById('studentInfoName').textContent = displayName;
        document.getElementById('studentInfoGrade').textContent = student.grade || 'N/A';
        document.getElementById('studentInfoBusAM').textContent = student.busAM || 'N/A';
        document.getElementById('studentInfoBusPM').textContent = student.busPM || 'N/A';
        document.getElementById('studentInfoAddress').textContent = student.address || 'N/A';
        document.getElementById('studentInfoDropoffAddress').textContent = student.dropoffAddress || 'N/A';
        document.getElementById('studentInfoParentName').textContent = student.parentName || 'N/A';
        document.getElementById('studentInfoHomePhone').textContent = student.homePhone || 'N/A';
        document.getElementById('studentInfoCellPhone').textContent = student.cellPhone || 'N/A';
        document.getElementById('studentInfoWorkPhone').textContent = student.workPhone || 'N/A';
        document.getElementById('studentInfoEmergencyContact').textContent = student.emergencyContact || 'N/A';
        
        if (student.otherInfo) {
            document.getElementById('studentInfoOtherInfo').textContent = student.otherInfo;
            document.getElementById('studentInfoOtherInfoContainer').style.display = 'block';
        } else {
            document.getElementById('studentInfoOtherInfoContainer').style.display = 'none';
        }
        
        document.getElementById('studentInfoModal').style.display = 'block';
    }

    closeStudentInfoModal() {
        document.getElementById('studentInfoModal').style.display = 'none';
        this.selectedSeat = null;
    }

    async unassignCurrentStudent() {
        if (!this.selectedSeat || !this.currentBusId) return;
        
        const { row, side, position } = this.selectedSeat;
        const route = this.currentRoute || 'AM';
        await this.unassignSeat(this.currentBusId, row, side, position, route);
        
        this.closeStudentInfoModal();
        this.renderBusDiagram();
        this.selectedSeat = null;
    }

    // Bus Modal
    openBusModal(busId = null) {
        this.editingBusId = busId;
        const modal = document.getElementById('busModal');
        const title = document.getElementById('busModalTitle');
        const nameInput = document.getElementById('busNameInput');
        const deleteBtn = document.getElementById('deleteBusBtn');
        
        if (busId) {
            const bus = this.busses.find(b => b.id === busId);
            if (bus) {
                title.textContent = 'Edit Bus';
                // Extract just the number from "Bus 12" -> "12"
                const busNumber = bus.name.replace(/^Bus\s+/i, '').trim();
                nameInput.value = busNumber;
                deleteBtn.style.display = 'block';
            }
        } else {
            title.textContent = 'Create Bus';
            nameInput.value = '';
            deleteBtn.style.display = 'none';
        }
        
        modal.style.display = 'block';
        nameInput.focus();
    }

    closeBusModal() {
        document.getElementById('busModal').style.display = 'none';
        this.editingBusId = null;
    }

    async saveBus() {
        const nameInput = document.getElementById('busNameInput');
        const busNumber = nameInput.value.trim();
        
        if (!busNumber) {
            alert('Please enter a bus number');
            return;
        }
        
        // Always prefix with "Bus "
        const name = `Bus ${busNumber}`;
        
        if (this.editingBusId) {
            const bus = this.busses.find(b => b.id === this.editingBusId);
            if (bus) {
                bus.name = name;
                await this.updateBus(bus);
            }
        } else {
            await this.addBus({ name });
        }
        
        this.closeBusModal();
        this.renderBusses();
    }

    async deleteCurrentBus() {
        if (!this.editingBusId) return;
        
        if (confirm('Are you sure you want to delete this bus? This will also delete all seat assignments.')) {
            await this.deleteBus(this.editingBusId);
            this.closeBusModal();
            this.renderBusses();
            
            if (this.currentBusId === this.editingBusId) {
                this.showMainScreen();
            }
        }
    }

    async deleteBusConfirm(busId) {
        const bus = this.busses.find(b => b.id === busId);
        const busName = bus ? bus.name : 'this bus';
        
        const warningMessage = `⚠️ WARNING: You are about to delete ${busName}.\n\nThis action will permanently delete:\n- The bus record\n- All AM route seat assignments\n- All PM route seat assignments\n\nThis action CANNOT be undone.\n\nType "${busName}" to confirm deletion:`;
        
        const userInput = prompt(warningMessage);
        
        if (userInput === busName) {
            await this.deleteBus(busId);
            this.renderBusses();
            
            // If we're currently viewing this bus, go back to main screen
            if (this.currentBusId === busId) {
                this.showMainScreen();
            }
        } else if (userInput !== null) {
            // User typed something but it was wrong
            alert('Bus name did not match. Deletion cancelled.');
        }
        // If userInput is null, they cancelled the prompt
    }


    // Settings Modal
    openSettingsModal() {
        document.getElementById('settingsModal').style.display = 'block';
        document.getElementById('firebaseSyncId').textContent = this.syncId;
        document.getElementById('syncIdInput').value = '';
        document.getElementById('versionText').textContent = 'App Version: ' + APP_VERSION;
        this.updateSyncStatus();
        this.updateEncryptionSettingsUI();
    }

    async updateEncryptionSettingsUI() {
        const requiredFromFirebase = await this.getEncryptionRequiredFromFirebase();
        const adminSection = document.getElementById('encryptionAdminSetupSection');
        const setSection = document.getElementById('encryptionSetPasswordSection');
        const statusSection = document.getElementById('encryptionStatusSection');
        if (requiredFromFirebase) {
            adminSection.style.display = 'none';
            statusSection.style.display = 'block';
            document.getElementById('encryptionCurrentPasswordInput').value = '';
            document.getElementById('encryptionNewPasswordInput').value = '';
            document.getElementById('encryptionNewPasswordConfirmInput').value = '';
            document.getElementById('encryptionChangePasswordError').style.display = 'none';
        } else {
            adminSection.style.display = 'block';
            statusSection.style.display = 'none';
            const checkbox = document.getElementById('encryptionEnabledCheckbox');
            checkbox.checked = this.isEncryptionEnabled();
            setSection.style.display = checkbox.checked ? 'block' : 'none';
            document.getElementById('encryptionSetPasswordInput').value = '';
            document.getElementById('encryptionConfirmPasswordInput').value = '';
            document.getElementById('encryptionSetPasswordError').style.display = 'none';
        }
    }

    async enableEncryptionWithPassword() {
        const pwd = document.getElementById('encryptionSetPasswordInput').value;
        const confirmPwd = document.getElementById('encryptionConfirmPasswordInput').value;
        const errEl = document.getElementById('encryptionSetPasswordError');
        errEl.style.display = 'none';
        if (!pwd || pwd.length < 6) {
            errEl.textContent = 'Use at least 6 characters.';
            errEl.style.display = 'block';
            return;
        }
        if (pwd !== confirmPwd) {
            errEl.textContent = 'Passwords do not match.';
            errEl.style.display = 'block';
            return;
        }
        this.encryptionKey = await this.deriveEncryptionKey(pwd);
        this.setEncryptionEnabled(true);
        await this.setEncryptionRequiredInFirebase(true, 1);
        await this.saveEncryptionKeyToStorage(this.encryptionKey, 1);
        this.updateEncryptionSettingsUI();
    }

    async changeEncryptionPasswordSubmit() {
        const current = document.getElementById('encryptionCurrentPasswordInput').value;
        const newPwd = document.getElementById('encryptionNewPasswordInput').value;
        const confirmPwd = document.getElementById('encryptionNewPasswordConfirmInput').value;
        const errEl = document.getElementById('encryptionChangePasswordError');
        const successEl = document.getElementById('encryptionChangePasswordSuccess');
        errEl.style.display = 'none';
        successEl.style.display = 'none';
        if (!current || !current.trim()) {
            errEl.textContent = 'Enter the current password.';
            errEl.style.display = 'block';
            return;
        }
        if (!newPwd || newPwd.length < 6) {
            errEl.textContent = 'New password must be at least 6 characters.';
            errEl.style.display = 'block';
            return;
        }
        if (newPwd !== confirmPwd) {
            errEl.textContent = 'New passwords do not match.';
            errEl.style.display = 'block';
            return;
        }
        const btn = document.getElementById('encryptionChangePasswordBtn');
        btn.disabled = true;
        btn.textContent = 'Changing...';
        try {
            await this.changeEncryptionPassword(current.trim(), newPwd.trim());
            successEl.style.display = 'block';
            document.getElementById('encryptionCurrentPasswordInput').value = '';
            document.getElementById('encryptionNewPasswordInput').value = '';
            document.getElementById('encryptionNewPasswordConfirmInput').value = '';
        } catch (e) {
            if (e.message === 'WRONG_PASSWORD') {
                errEl.textContent = 'Current password is incorrect.';
            } else {
                errEl.textContent = e.message || 'Could not change password.';
            }
            errEl.style.display = 'block';
        } finally {
            btn.disabled = false;
            btn.textContent = 'Change password';
        }
    }

    closeSettingsModal() {
        document.getElementById('settingsModal').style.display = 'none';
    }

    closeModal(modalId) {
        document.getElementById(modalId).style.display = 'none';
        if (modalId === 'busModal') {
            this.editingBusId = null;
        } else if (modalId === 'studentModal') {
            this.editingStudentId = null;
        }
    }

    updateSyncStatus() {
        const statusEl = document.getElementById('firebaseSyncStatus');
        if (this.firebaseEnabled) {
            statusEl.textContent = 'Connected';
            statusEl.style.color = 'var(--success-color)';
        } else {
            statusEl.textContent = 'Not Connected';
            statusEl.style.color = 'var(--text-secondary)';
        }
    }

    async manualSync() {
        const messageEl = document.getElementById('firebaseSyncMessage');
        messageEl.textContent = 'Syncing...';
        
        try {
            // Sync all busses
            for (const bus of this.busses) {
                await this.syncToFirebase('busses', bus);
            }
            
            // Sync all students
            for (const student of this.students) {
                await this.syncToFirebase('students', student);
            }
            
            // Sync all seat assignments
            for (const bus of this.busses) {
                const assignments = await this.getSeatAssignments(bus.id);
                for (const assignment of assignments) {
                    await this.syncToFirebase('seatAssignments', assignment);
                }
            }
            
            // Sync all check-ins
            for (const checkin of this.checkins) {
                await this.syncToFirebase('checkins', checkin);
            }
            
            // Sync all route rows
            for (const row of this.routeRows) {
                await this.syncToFirebase('routeRows', row);
            }
            
            messageEl.textContent = 'Sync complete!';
            messageEl.style.color = 'var(--success-color)';
            setTimeout(() => {
                messageEl.textContent = '';
            }, 3000);
        } catch (error) {
            messageEl.textContent = 'Sync failed: ' + error.message;
            messageEl.style.color = 'var(--danger-color)';
        }
    }

    // Export all data from IndexedDB to a JSON file (works even when running from file://)
    async exportAllData() {
        const backup = await this.getAllDataForExport();
        const json = JSON.stringify(backup, null, 2);
        const blob = new Blob([json], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `bus-tracker-backup-${new Date().toISOString().slice(0, 10)}.json`;
        a.click();
        URL.revokeObjectURL(url);
    }

    getAllDataForExport() {
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction(['busses', 'students', 'seatAssignments', 'checkins', 'routeRows'], 'readonly');
            const busStore = transaction.objectStore('busses');
            const studentStore = transaction.objectStore('students');
            const assignmentStore = transaction.objectStore('seatAssignments');
            const checkinStore = transaction.objectStore('checkins');
            const routeRowStore = transaction.objectStore('routeRows');
            const result = { busses: [], students: [], seatAssignments: [], checkins: [], routeRows: [] };
            busStore.getAll().onsuccess = (e) => {
                result.busses = e.target.result || [];
                studentStore.getAll().onsuccess = (e2) => {
                    result.students = e2.target.result || [];
                    assignmentStore.getAll().onsuccess = (e3) => {
                        result.seatAssignments = e3.target.result || [];
                        checkinStore.getAll().onsuccess = (e4) => {
                            result.checkins = e4.target.result || [];
                            routeRowStore.getAll().onsuccess = (e5) => {
                                result.routeRows = e5.target.result || [];
                                resolve(result);
                            };
                        };
                    };
                };
            };
            transaction.onerror = () => reject(transaction.error);
        });
    }

    // Import from backup JSON and optionally push to Firebase
    async importFromBackup(file) {
        if (!file || !file.name.endsWith('.json')) {
            alert('Please select a valid backup JSON file.');
            return;
        }
        const messageEl = document.getElementById('backupImportMessage');
        messageEl.textContent = 'Importing...';
        messageEl.style.color = 'var(--text-secondary)';
        messageEl.style.display = 'block';
        try {
            const text = await file.text();
            const backup = JSON.parse(text);
            if (!backup.busses || !Array.isArray(backup.busses)) {
                throw new Error('Invalid backup file: missing busses array');
            }
            const busses = backup.busses || [];
            const students = backup.students || [];
            const seatAssignments = backup.seatAssignments || [];
            const checkins = backup.checkins || [];
            const routeRows = backup.routeRows || [];

            const transaction = this.db.transaction(['busses', 'students', 'seatAssignments', 'checkins', 'routeRows'], 'readwrite');
            const busStore = transaction.objectStore('busses');
            const studentStore = transaction.objectStore('students');
            const assignmentStore = transaction.objectStore('seatAssignments');
            const checkinStore = transaction.objectStore('checkins');
            const routeRowStore = transaction.objectStore('routeRows');

            busStore.clear();
            studentStore.clear();
            assignmentStore.clear();
            checkinStore.clear();
            routeRowStore.clear();

            for (const bus of busses) busStore.put(bus);
            for (const student of students) studentStore.put(student);
            for (const a of seatAssignments) assignmentStore.put(a);
            for (const c of checkins) checkinStore.put(c);
            for (const r of routeRows) routeRowStore.put(r);

            await new Promise((resolve, reject) => {
                transaction.oncomplete = resolve;
                transaction.onerror = () => reject(transaction.error);
            });

            await this.loadData();
            this.renderBusses();
            if (this.currentBusId) await this.renderBusDiagram();

            messageEl.textContent = `Imported ${busses.length} busses, ${students.length} students.`;
            messageEl.style.color = 'var(--success-color)';

            if (this.firebaseEnabled) {
                messageEl.textContent += ' Pushing to cloud...';
                await this.manualSync();
                messageEl.textContent = 'Imported and synced to cloud. Your phone will update automatically.';
            } else {
                messageEl.textContent += ' Open the app from your GitHub Pages URL and click "Force Sync Now" to sync to your phone.';
            }
            document.getElementById('backupImportFileInput').value = '';
            setTimeout(() => { messageEl.style.display = 'none'; }, 8000);
        } catch (err) {
            messageEl.textContent = 'Import failed: ' + (err.message || String(err));
            messageEl.style.color = 'var(--danger-color)';
            document.getElementById('backupImportFileInput').value = '';
        }
    }

    // Student Modal
    openStudentModal(studentId = null) {
        this.editingStudentId = studentId;
        const modal = document.getElementById('studentModal');
        const title = document.getElementById('studentModalTitle');
        const deleteBtn = document.getElementById('deleteStudentBtn');
        const addRowBtn = document.getElementById('addStudentRowBtn');
        const container = document.getElementById('studentNameRowsContainer');
        
        // Close student search modal if open
        this.closeStudentSearchModal();
        
        // Clear existing student name rows
        container.innerHTML = '';
        
        if (studentId) {
            const student = this.students.find(s => s.id === studentId);
            if (student) {
                title.textContent = 'Edit Student';
                this.addStudentNameRow({
                    firstName: student.firstName || '',
                    lastName: student.lastName || '',
                    grade: student.grade || ''
                });
                document.getElementById('studentBusAMInput').value = student.busAM || '';
                document.getElementById('studentBusPMInput').value = student.busPM || '';
                document.getElementById('studentAddressInput').value = student.address || '';
                document.getElementById('studentDropoffAddressInput').value = student.dropoffAddress || '';
                document.getElementById('studentParentNameInput').value = student.parentName || '';
                document.getElementById('studentHomePhoneInput').value = student.homePhone || '';
                document.getElementById('studentCellPhoneInput').value = student.cellPhone || '';
                document.getElementById('studentWorkPhoneInput').value = student.workPhone || '';
                document.getElementById('studentEmergencyContactInput').value = student.emergencyContact || '';
                document.getElementById('studentOtherInfoInput').value = student.otherInfo || '';
                deleteBtn.style.display = 'block';
                addRowBtn.style.display = 'none';
            }
        } else {
            title.textContent = 'Add New Student';
            document.getElementById('studentForm').reset();
            container.innerHTML = '';
            this.addStudentNameRow();
            deleteBtn.style.display = 'none';
            addRowBtn.style.display = 'block';
        }
        
        modal.style.display = 'block';
        const firstInput = container.querySelector('.student-row-first');
        if (firstInput) firstInput.focus();
    }

    closeStudentModal() {
        document.getElementById('studentModal').style.display = 'none';
        this.editingStudentId = null;
    }

    showEncryptionPasswordModal() {
        document.getElementById('encryptionPasswordError').style.display = 'none';
        document.getElementById('encryptionPasswordInput').value = '';
        document.getElementById('encryptionPasswordModal').style.display = 'block';
        document.getElementById('encryptionPasswordInput').focus();
    }

    closeEncryptionPasswordModal() {
        document.getElementById('encryptionPasswordModal').style.display = 'none';
    }

    async handleEncryptionUnlock(password) {
        const errEl = document.getElementById('encryptionPasswordError');
        errEl.style.display = 'none';
        if (!password || !password.trim()) {
            errEl.textContent = 'Please enter the password.';
            errEl.style.display = 'block';
            return;
        }
        try {
            this.encryptionKey = await this.deriveEncryptionKey(password.trim());
            await this.syncFromFirebase();
            const encConfig = await this.getEncryptionConfigFromFirebase();
            await this.saveEncryptionKeyToStorage(this.encryptionKey, encConfig.keyVersion);
            this.closeEncryptionPasswordModal();
            await this.loadData();
            this.initializeApp();
        } catch (e) {
            if (e.message === 'WRONG_PASSWORD') {
                errEl.textContent = 'Wrong password. Please try again.';
            } else {
                errEl.textContent = e.message || 'Could not unlock.';
            }
            errEl.style.display = 'block';
        }
    }

    addStudentNameRow(data = {}) {
        const container = document.getElementById('studentNameRowsContainer');
        const row = document.createElement('div');
        row.className = 'student-name-row';
        row.innerHTML = `
            <div class="form-group" style="display: grid; grid-template-columns: 1fr 1fr auto auto; gap: 8px; align-items: end; margin-bottom: 10px;">
                <div>
                    <label class="sr-only">First name</label>
                    <input type="text" class="form-control student-row-first" placeholder="First name" value="${this.escapeHtml(data.firstName || '')}">
                </div>
                <div>
                    <label class="sr-only">Last name</label>
                    <input type="text" class="form-control student-row-last" placeholder="Last name" value="${this.escapeHtml(data.lastName || '')}">
                </div>
                <div>
                    <label class="sr-only">Grade</label>
                    <input type="text" class="form-control student-row-grade" placeholder="Grade" value="${this.escapeHtml(data.grade || '')}" style="max-width: 80px;">
                </div>
                <button type="button" class="btn btn-secondary remove-student-row-btn" title="Remove this student" style="padding: 8px 12px;">&times;</button>
            </div>
        `;
        container.appendChild(row);
    }

    removeStudentNameRow(rowEl) {
        if (!rowEl || !rowEl.classList.contains('student-name-row')) return;
        const container = document.getElementById('studentNameRowsContainer');
        const rows = container.querySelectorAll('.student-name-row');
        if (rows.length <= 1) return;
        rowEl.remove();
    }

    openAddMultipleStudentsModal() {
        document.getElementById('addMultipleStudentsModal').style.display = 'block';
        document.getElementById('addMultipleStudentsForm').reset();
        document.getElementById('multiStudentNamesInput').focus();
    }

    closeAddMultipleStudentsModal() {
        document.getElementById('addMultipleStudentsModal').style.display = 'none';
    }

    async saveMultipleStudents() {
        const namesText = document.getElementById('multiStudentNamesInput').value.trim();
        if (!namesText) {
            alert('Please enter at least one student name (one per line).');
            return;
        }

        const lines = namesText.split(/\r?\n/).map(line => line.trim()).filter(line => line.length > 0);
        const names = [];
        for (const line of lines) {
            const parts = line.split(/\s+/);
            const firstName = parts[0] || '';
            const lastName = parts.slice(1).join(' ').trim();
            if (firstName) {
                names.push({ firstName, lastName });
            }
        }

        if (names.length === 0) {
            alert('Please enter at least one valid name (e.g. First Last).');
            return;
        }

        const shared = {
            grade: document.getElementById('multiGradeInput').value.trim(),
            busAM: document.getElementById('multiBusAMInput').value.trim(),
            busPM: document.getElementById('multiBusPMInput').value.trim(),
            address: document.getElementById('multiAddressInput').value.trim(),
            dropoffAddress: document.getElementById('multiDropoffAddressInput').value.trim(),
            parentName: document.getElementById('multiParentNameInput').value.trim(),
            homePhone: document.getElementById('multiHomePhoneInput').value.trim(),
            cellPhone: document.getElementById('multiCellPhoneInput').value.trim(),
            workPhone: document.getElementById('multiWorkPhoneInput').value.trim(),
            emergencyContact: document.getElementById('multiEmergencyContactInput').value.trim(),
            otherInfo: document.getElementById('multiOtherInfoInput').value.trim()
        };

        for (const { firstName, lastName } of names) {
            const student = {
                firstName,
                lastName,
                ...shared
            };
            student.name = `${firstName} ${lastName}`.trim();
            await this.addStudent(student);
        }

        this.closeAddMultipleStudentsModal();
        if (this.selectedSeat) {
            this.showStudentSearchModal();
        } else {
            this.closeStudentSearchModal();
        }
        alert(`Created ${names.length} student profile(s).`);
    }

    async saveStudent() {
        const container = document.getElementById('studentNameRowsContainer');
        const rows = container.querySelectorAll('.student-name-row');
        const shared = {
            busAM: document.getElementById('studentBusAMInput').value.trim(),
            busPM: document.getElementById('studentBusPMInput').value.trim(),
            address: document.getElementById('studentAddressInput').value.trim(),
            dropoffAddress: document.getElementById('studentDropoffAddressInput').value.trim(),
            parentName: document.getElementById('studentParentNameInput').value.trim(),
            homePhone: document.getElementById('studentHomePhoneInput').value.trim(),
            cellPhone: document.getElementById('studentCellPhoneInput').value.trim(),
            workPhone: document.getElementById('studentWorkPhoneInput').value.trim(),
            emergencyContact: document.getElementById('studentEmergencyContactInput').value.trim(),
            otherInfo: document.getElementById('studentOtherInfoInput').value.trim()
        };

        if (this.editingStudentId) {
            const row = rows[0];
            if (!row) return;
            const firstName = row.querySelector('.student-row-first').value.trim();
            const lastName = row.querySelector('.student-row-last').value.trim();
            if (!firstName || !lastName) {
                alert('Please enter both first and last name');
                return;
            }
            const student = {
                firstName,
                lastName,
                grade: row.querySelector('.student-row-grade').value.trim(),
                ...shared
            };
            student.name = `${firstName} ${lastName}`;
            const existing = this.students.find(s => s.id === this.editingStudentId);
            if (existing) {
                Object.assign(existing, student);
                existing.id = this.editingStudentId;
                await this.updateStudent(existing);
            }
        } else {
            const toAdd = [];
            for (const row of rows) {
                const firstName = row.querySelector('.student-row-first').value.trim();
                const lastName = row.querySelector('.student-row-last').value.trim();
                if (!firstName && !lastName) continue;
                if (!firstName || !lastName) {
                    alert('Please enter both first and last name for each student.');
                    return;
                }
                const student = {
                    firstName,
                    lastName,
                    grade: row.querySelector('.student-row-grade').value.trim(),
                    ...shared
                };
                student.name = `${firstName} ${lastName}`;
                toAdd.push(student);
            }
            if (toAdd.length === 0) {
                alert('Please enter at least one student (first and last name).');
                return;
            }
            for (const student of toAdd) {
                await this.addStudent(student);
            }
        }
        
        this.closeStudentModal();
        
        if (this.selectedSeat) {
            this.showStudentSearchModal();
        }
    }

    async deleteCurrentStudent() {
        if (!this.editingStudentId) return;
        
        if (confirm('Are you sure you want to delete this student? This will also remove them from any assigned seats.')) {
            await this.deleteStudent(this.editingStudentId);
            this.closeStudentModal();
            
            // Refresh bus diagram if open
            if (this.currentBusId) {
                this.renderBusDiagram();
            }
        }
    }

    // Update Management
    // Check Firebase for app version updates
    async checkFirebaseVersion() {
        if (!this.firebaseEnabled || !window.db) return;
        
        try {
            const versionDoc = await window.db.collection('busTracker').doc('appVersion').get();
            
            if (versionDoc.exists) {
                const firebaseVersion = versionDoc.data().version;
                if (this.compareVersions(firebaseVersion, APP_VERSION) > 0) {
                    // New version available
                    document.getElementById('updateBanner').classList.remove('hidden');
                    console.log(`New version available: ${firebaseVersion} (current: ${APP_VERSION})`);
                }
            }
        } catch (error) {
            console.error('Error checking Firebase version:', error);
        }
    }

    // Compare version strings (returns 1 if v1 > v2, -1 if v1 < v2, 0 if equal)
    compareVersions(v1, v2) {
        const parts1 = v1.split('.').map(Number);
        const parts2 = v2.split('.').map(Number);
        
        for (let i = 0; i < Math.max(parts1.length, parts2.length); i++) {
            const part1 = parts1[i] || 0;
            const part2 = parts2[i] || 0;
            
            if (part1 > part2) return 1;
            if (part1 < part2) return -1;
        }
        
        return 0;
    }

    checkForUpdates(manual = false) {
        if ('serviceWorker' in navigator) {
            navigator.serviceWorker.getRegistration().then(registration => {
                if (registration) {
                    registration.update();
                    registration.addEventListener('updatefound', () => {
                        const newWorker = registration.installing;
                        newWorker.addEventListener('statechange', () => {
                            if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
                                if (!manual) {
                                    document.getElementById('updateBanner').classList.remove('hidden');
                                } else {
                                    const statusText = document.getElementById('updateStatusText');
                                    statusText.textContent = 'Update available! Refresh the page.';
                                    statusText.style.color = 'var(--success-color)';
                                }
                            }
                        });
                    });
                }
            });
        }
        
        // Also check Firebase version on manual check
        if (manual) {
            this.checkFirebaseVersion();
            const statusText = document.getElementById('updateStatusText');
            statusText.textContent = 'Checking for updates...';
            statusText.style.color = 'var(--text-secondary)';
            setTimeout(() => {
                if (statusText.textContent === 'Checking for updates...') {
                    statusText.textContent = 'No updates available.';
                    statusText.style.color = 'var(--text-secondary)';
                }
            }, 2000);
        }
    }

    updateApp() {
        if ('serviceWorker' in navigator) {
            navigator.serviceWorker.getRegistration().then(registration => {
                if (registration && registration.waiting) {
                    registration.waiting.postMessage({ type: 'SKIP_WAITING' });
                    window.location.reload();
                }
            });
        }
    }

    // Check-In Functions
    async openCheckinModal() {
        if (!this.currentBusId) return;
        
        const bus = this.busses.find(b => b.id === this.currentBusId);
        const route = this.currentRoute || 'AM';
        const today = new Date().toISOString().split('T')[0];
        
        document.getElementById('checkinBusName').textContent = bus ? bus.name : 'Unknown Bus';
        document.getElementById('checkinRoute').textContent = route;
        document.getElementById('checkinDate').textContent = new Date(today).toLocaleDateString();
        
        // Get all students assigned to this bus/route
        const assignments = await this.getSeatAssignments(this.currentBusId, route);
        const assignedStudentIds = assignments.map(a => a.studentId);
        const assignedStudents = this.students.filter(s => assignedStudentIds.includes(s.id));
        
        // Get today's check-ins for this bus/route
        const todayCheckins = await this.getCheckinsForDate(this.currentBusId, today, route);
        const checkedInIds = todayCheckins.map(c => c.studentId);
        
        // Get extra students (checked in but not in assigned list)
        const extraCheckins = todayCheckins.filter(c => !assignedStudentIds.includes(c.studentId));
        const extraStudentIds = extraCheckins.map(c => c.studentId);
        const extraStudents = this.students.filter(s => extraStudentIds.includes(s.id));
        
        // Combine assigned and extra students, sorted by first name
        const allCheckinStudents = [...assignedStudents, ...extraStudents].sort((a, b) => {
            const firstA = (a.firstName || (a.name || '').split(' ')[0] || '').toLowerCase();
            const firstB = (b.firstName || (b.name || '').split(' ')[0] || '').toLowerCase();
            return firstA.localeCompare(firstB);
        });
        const totalCheckedIn = checkedInIds.length;
        const assignedCheckedIn = assignedStudents.filter(s => checkedInIds.includes(s.id)).length;
        
        // Update stats
        document.getElementById('checkinTotal').textContent = assignedStudents.length;
        document.getElementById('checkinCheckedIn').textContent = totalCheckedIn;
        document.getElementById('checkinNotCheckedIn').textContent = assignedStudents.length - assignedCheckedIn;
        
        // Clear search
        document.getElementById('checkinStudentSearchInput').value = '';
        document.getElementById('checkinStudentSearchResults').style.display = 'none';
        document.getElementById('checkinStudentSearchResults').innerHTML = '';
        
        // Render student list
        const container = document.getElementById('checkinStudentsList');
        container.innerHTML = allCheckinStudents.map(student => {
            const isCheckedIn = checkedInIds.includes(student.id);
            const checkin = todayCheckins.find(c => c.studentId === student.id);
            const isExtra = !assignedStudentIds.includes(student.id);
            const displayName = student.firstName && student.lastName 
                ? `${student.firstName} ${student.lastName}`
                : student.name || 'Unknown';
            
            return `
                <div class="checkin-student-item" style="display: flex; justify-content: space-between; align-items: center; padding: 12px; margin-bottom: 8px; background: ${isCheckedIn ? 'rgba(52, 197, 26, 0.1)' : 'var(--card-bg)'}; border: 2px solid ${isCheckedIn ? 'var(--success-color)' : 'var(--border-color)'}; border-radius: 8px; ${isExtra ? 'border-left: 4px solid #FF9800;' : ''}">
                    <div style="flex: 1;">
                        <div style="display: flex; align-items: center; gap: 8px;">
                            <div style="font-size: 16px; font-weight: 600; color: var(--text-primary);">${this.escapeHtml(displayName)}</div>
                            ${isExtra ? '<span style="background: #FF9800; color: white; padding: 2px 8px; border-radius: 4px; font-size: 11px; font-weight: 600;">EXTRA</span>' : ''}
                        </div>
                        <div style="font-size: 13px; color: var(--text-secondary);">
                            ${student.grade ? `Grade ${student.grade}` : ''}
                            ${checkin ? ` • Checked in at ${new Date(checkin.timestamp).toLocaleTimeString()}` : ''}
                        </div>
                    </div>
                    <button class="btn ${isCheckedIn ? 'btn-secondary' : 'btn-primary'}" 
                            onclick="app.toggleCheckin('${student.id}', ${isExtra})"
                            style="padding: 8px 16px; font-size: 14px;">
                        ${isCheckedIn ? '✓ Checked In' : 'Check In'}
                    </button>
                </div>
            `;
        }).join('');
        
        document.getElementById('checkinModal').style.display = 'block';
    }

    closeCheckinModal() {
        document.getElementById('checkinModal').style.display = 'none';
    }

    async toggleCheckin(studentId, isExtra = false) {
        if (!this.currentBusId) return;
        
        const route = this.currentRoute || 'AM';
        const today = new Date().toISOString().split('T')[0];
        
        // Check if already checked in
        const todayCheckins = await this.getCheckinsForDate(this.currentBusId, today, route);
        const existingCheckin = todayCheckins.find(c => c.studentId === studentId);
        
        if (existingCheckin) {
            // Remove check-in
            await this.removeCheckin(existingCheckin.id);
        } else {
            // Add check-in
            await this.addCheckin({
                busId: this.currentBusId,
                route: route,
                studentId: studentId,
                date: today,
                timestamp: new Date().toISOString(),
                isExtra: isExtra || false
            });
        }
        
        // Refresh the check-in modal
        this.openCheckinModal();
    }

    filterCheckinStudents(searchTerm) {
        const container = document.getElementById('checkinStudentSearchResults');
        const term = searchTerm.trim().toLowerCase();
        
        if (!term) {
            container.style.display = 'none';
            container.innerHTML = '';
            return;
        }
        
        // Get assigned students to exclude them
        this.getSeatAssignments(this.currentBusId, this.currentRoute || 'AM').then(assignments => {
            const assignedStudentIds = assignments.map(a => a.studentId);
            
            // Filter students not in assigned list
            const filtered = this.students.filter(student => {
                const firstName = (student.firstName || '').toLowerCase();
                const lastName = (student.lastName || '').toLowerCase();
                const name = (student.name || '').toLowerCase();
                
                const matches = firstName.includes(term) || lastName.includes(term) || name.includes(term);
                return matches && !assignedStudentIds.includes(student.id);
            });
            
            if (filtered.length === 0) {
                container.style.display = 'none';
                container.innerHTML = '';
                return;
            }
            
            container.style.display = 'block';
            container.innerHTML = filtered.map(student => {
                const displayName = student.firstName && student.lastName 
                    ? `${student.firstName} ${student.lastName}`
                    : student.name || 'Unknown';
                return `
                    <div class="student-item" onclick="app.addExtraCheckinStudentById('${student.id}')" style="padding: 10px; margin-bottom: 5px; background: var(--card-bg); border: 1px solid var(--border-color); border-radius: 6px; cursor: pointer;">
                        <div class="student-name">${this.escapeHtml(displayName)}</div>
                        <div class="student-meta" style="font-size: 12px; color: var(--text-secondary);">
                            ${student.grade ? `Grade ${student.grade}` : ''}
                        </div>
                    </div>
                `;
            }).join('');
        });
    }

    async addExtraCheckinStudent() {
        const searchInput = document.getElementById('checkinStudentSearchInput');
        const term = searchInput.value.trim().toLowerCase();
        
        if (!term) {
            alert('Please enter a student name to search');
            return;
        }
        
        // Get assigned students to exclude them
        const assignments = await this.getSeatAssignments(this.currentBusId, this.currentRoute || 'AM');
        const assignedStudentIds = assignments.map(a => a.studentId);
        
        // Find matching student not in assigned list
        const student = this.students.find(s => {
            const firstName = (s.firstName || '').toLowerCase();
            const lastName = (s.lastName || '').toLowerCase();
            const name = (s.name || '').toLowerCase();
            const matches = firstName.includes(term) || lastName.includes(term) || name.includes(term);
            return matches && !assignedStudentIds.includes(s.id);
        });
        
        if (student) {
            await this.addExtraCheckinStudentById(student.id);
        } else {
            alert('No matching student found who is not already on the list');
        }
    }

    async addExtraCheckinStudentById(studentId) {
        const route = this.currentRoute || 'AM';
        const today = new Date().toISOString().split('T')[0];
        
        // Check if already checked in
        const todayCheckins = await this.getCheckinsForDate(this.currentBusId, today, route);
        const existingCheckin = todayCheckins.find(c => c.studentId === studentId);
        
        if (!existingCheckin) {
            await this.addCheckin({
                busId: this.currentBusId,
                route: route,
                studentId: studentId,
                date: today,
                timestamp: new Date().toISOString(),
                isExtra: true
            });
        }
        
        // Refresh the check-in modal
        this.openCheckinModal();
    }

    async getCheckinsForDate(busId, date, route) {
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction(['checkins'], 'readonly');
            const store = transaction.objectStore('checkins');
            const index = store.index('busDateRoute');
            const key = [busId, date, route];
            const range = IDBKeyRange.only(key);
            const request = index.getAll(range);
            
            request.onsuccess = () => {
                resolve(request.result || []);
            };
            
            request.onerror = () => {
                reject(request.error);
            };
        });
    }

    async addCheckinToIndexedDB(checkin) {
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction(['checkins'], 'readwrite');
            const store = transaction.objectStore('checkins');
            const request = store.put(checkin);
            
            request.onsuccess = () => {
                const index = this.checkins.findIndex(c => c.id === checkin.id);
                if (index === -1) {
                    this.checkins.push(checkin);
                } else {
                    this.checkins[index] = checkin;
                }
                resolve(checkin);
            };
            
            request.onerror = () => {
                reject(request.error);
            };
        });
    }

    async addCheckin(checkin) {
        checkin.id = checkin.id || this.generateId();
        await this.addCheckinToIndexedDB(checkin);
        this.syncToFirebase('checkins', checkin);
        return checkin;
    }

    async removeCheckin(checkinId) {
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction(['checkins'], 'readwrite');
            const store = transaction.objectStore('checkins');
            const request = store.delete(checkinId);
            
            request.onsuccess = () => {
                this.checkins = this.checkins.filter(c => c.id !== checkinId);
                this.syncToFirebase('checkins', null, checkinId);
                resolve();
            };
            
            request.onerror = () => {
                reject(request.error);
            };
        });
    }

    // --- Route Rows (spreadsheet route stops) ---
    async getRouteRows(busId, route) {
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction(['routeRows'], 'readonly');
            const store = transaction.objectStore('routeRows');
            const index = store.index('busRoute');
            const range = IDBKeyRange.only([busId, route]);
            const request = index.getAll(range);
            request.onsuccess = () => {
                const rows = (request.result || []).slice().sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
                resolve(rows);
            };
            request.onerror = () => reject(request.error);
        });
    }

    async addRouteRowToIndexedDB(row) {
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction(['routeRows'], 'readwrite');
            const store = transaction.objectStore('routeRows');
            const request = store.put(row);
            request.onsuccess = () => {
                const idx = this.routeRows.findIndex(r => r.id === row.id);
                if (idx === -1) this.routeRows.push(row);
                else this.routeRows[idx] = row;
                resolve(row);
            };
            request.onerror = () => reject(request.error);
        });
    }

    async addRouteRow(row) {
        row.id = row.id || this.generateId();
        await this.addRouteRowToIndexedDB(row);
        this.syncToFirebase('routeRows', row);
        return row;
    }

    async updateRouteRow(row) {
        await this.addRouteRowToIndexedDB(row);
        this.syncToFirebase('routeRows', row);
        return row;
    }

    async deleteRouteRow(rowId) {
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction(['routeRows'], 'readwrite');
            const store = transaction.objectStore('routeRows');
            const request = store.delete(rowId);
            request.onsuccess = () => {
                this.routeRows = this.routeRows.filter(r => r.id !== rowId);
                this.syncToFirebase('routeRows', null, rowId);
                resolve();
            };
            request.onerror = () => reject(request.error);
        });
    }

    getStudentDisplayName(student) {
        if (!student) return '';
        if (student.firstName && student.lastName) return `${student.firstName} ${student.lastName}`.trim();
        return (student.name || student.firstName || '').trim();
    }

    normalizeAddressForMatch(addr) {
        if (!addr || typeof addr !== 'string') return '';
        return addr.trim().toLowerCase().replace(/\s+/g, ' ');
    }

    getStudentsAtAddress(address) {
        const normalized = this.normalizeAddressForMatch(address);
        if (!normalized) return [];
        return this.students.filter(s => {
            const a = this.normalizeAddressForMatch(s.dropoffAddress || s.address || '');
            return a && a === normalized;
        });
    }

    getRouteRowStudentNames(row) {
        if (row.studentId) {
            const student = this.students.find(s => s.id === row.studentId);
            if (student) {
                const address = (student.dropoffAddress || student.address || '').trim();
                const atAddress = this.getStudentsAtAddress(address);
                if (atAddress.length > 0) {
                    return atAddress.map(s => this.getStudentDisplayName(s)).filter(Boolean).join(', ');
                }
                return this.getStudentDisplayName(student);
            }
        }
        return row.studentName || '';
    }

    async openRouteModal() {
        if (!this.currentBusId) return;
        this.routeModalEditMode = false;
        const route = this.currentRoute || 'AM';
        const bus = this.busses.find(b => b.id === this.currentBusId);
        document.getElementById('routeModalTitle').textContent = 'Route';
        document.getElementById('routeModalBusRoute').textContent = bus ? `Bus ${this.escapeHtml(bus.name)} – ${route} Route` : `${route} Route`;
        this.updateRouteModalViewEditButtons();
        await this.renderRouteTable();
        document.getElementById('routeModal').style.display = 'block';
    }

    updateRouteModalViewEditButtons() {
        const isEdit = this.routeModalEditMode;
        document.getElementById('routeEditBtn').style.display = isEdit ? 'none' : 'inline-block';
        const editActions = document.getElementById('routeEditModeActions');
        editActions.style.display = isEdit ? 'flex' : 'none';
    }

    closeRouteModal() {
        document.getElementById('routeModal').style.display = 'none';
    }

    formatTimeDisplay(value) {
        if (!value || typeof value !== 'string') return '';
        const digits = value.replace(/\D/g, '').slice(0, 4);
        if (digits.length === 0) return value;
        if (digits.length === 1) return digits;
        if (digits.length === 2) {
            const hour = digits.slice(0, 2);
            return (hour === '10' || hour === '11' || hour === '12') ? digits + ':' : digits[0] + ':' + digits[1];
        }
        if (digits.length === 3) {
            const hour = digits.slice(0, 2);
            return (hour === '10' || hour === '11' || hour === '12') ? digits.slice(0, 2) + ':' + digits[2] : digits[0] + ':' + digits.slice(1, 3);
        }
        const hour = digits.slice(0, 2);
        return (hour === '10' || hour === '11' || hour === '12') ? digits.slice(0, 2) + ':' + digits.slice(2, 4) : digits[0] + ':' + digits.slice(1, 4);
    }

    formatTimeAsYouType(inputEl) {
        const raw = inputEl.value;
        const digits = raw.replace(/\D/g, '').slice(0, 4);
        if (digits.length === 0) {
            inputEl.value = '';
            return;
        }
        if (digits.length === 1) {
            inputEl.value = digits;
            return;
        }
        const hour2 = digits.slice(0, 2);
        const useTwoDigitHour = (hour2 === '10' || hour2 === '11' || hour2 === '12');
        if (digits.length === 2) {
            inputEl.value = useTwoDigitHour ? digits + ':' : digits[0] + ':' + digits[1];
            return;
        }
        if (digits.length === 3) {
            inputEl.value = useTwoDigitHour ? digits.slice(0, 2) + ':' + digits[2] : digits[0] + ':' + digits.slice(1, 3);
            return;
        }
        inputEl.value = useTwoDigitHour ? digits.slice(0, 2) + ':' + digits.slice(2, 4) : digits[0] + ':' + digits.slice(1, 4);
    }

    async renderRouteTable() {
        const busId = this.currentBusId;
        const route = this.currentRoute || 'AM';
        const rows = await this.getRouteRows(busId, route);
        const tbody = document.getElementById('routeTableBody');
        const table = document.getElementById('routeTable');
        const isEdit = this.routeModalEditMode;
        if (table) table.classList.toggle('route-table-view-mode', !isEdit);
        tbody.innerHTML = '';
        rows.forEach((row, index) => {
            const studentName = this.getRouteRowStudentNames(row);
            const timeDisplay = this.formatTimeDisplay(row.time || '');
            const tr = document.createElement('tr');
            tr.dataset.rowId = row.id;
            if (isEdit) {
                tr.innerHTML = `
                    <td class="route-col-order">${index + 1}</td>
                    <td class="route-col-action"><input type="text" class="route-input route-action" data-field="action" value="${this.escapeHtml(row.action || '')}" placeholder=""></td>
                    <td class="route-col-direction"><input type="text" class="route-input route-direction" data-field="direction" value="${this.escapeHtml(row.direction || '')}" placeholder=""></td>
                    <td class="route-col-address"><input type="text" class="route-input route-address" data-field="streetAddress" value="${this.escapeHtml(row.streetAddress || '')}" placeholder="Street address"></td>
                    <td class="route-col-student">
                        <div class="route-student-cell">
                            <input type="text" class="route-input route-student-input" data-field="studentSearch" value="${this.escapeHtml(studentName)}" placeholder="Search student..." autocomplete="off">
                            <input type="hidden" class="route-student-id" data-field="studentId" value="${row.studentId || ''}">
                            <div class="route-student-dropdown hidden" data-dropdown></div>
                        </div>
                    </td>
                    <td class="route-col-roadside"><input type="text" class="route-input route-roadside" data-field="roadside" value="${this.escapeHtml(row.roadside || '')}" placeholder="Left/Right"></td>
                    <td class="route-col-time"><input type="text" class="route-input route-time" data-field="time" value="${this.escapeHtml(timeDisplay)}" placeholder="" maxlength="5" inputmode="numeric"></td>
                    <td class="route-col-actions">
                        <button type="button" class="btn btn-secondary route-insert-above" title="Insert row above" style="padding: 4px 6px; font-size: 11px;">+↑</button>
                        <button type="button" class="btn btn-secondary route-insert-below" title="Insert row below" style="padding: 4px 6px; font-size: 11px;">+↓</button>
                        <button type="button" class="btn btn-danger route-delete-row" title="Delete row" style="padding: 4px 8px; font-size: 12px;">✕</button>
                    </td>
                `;
            } else {
                tr.innerHTML = `
                    <td class="route-col-order">${index + 1}</td>
                    <td class="route-col-action">${this.escapeHtml(row.action || '—')}</td>
                    <td class="route-col-direction">${this.escapeHtml(row.direction || '—')}</td>
                    <td class="route-col-address">${this.escapeHtml(row.streetAddress || '—')}</td>
                    <td class="route-col-student">${this.escapeHtml(studentName || '—')}</td>
                    <td class="route-col-roadside">${this.escapeHtml(row.roadside || '—')}</td>
                    <td class="route-col-time">${this.escapeHtml(timeDisplay || '—')}</td>
                    <td class="route-col-actions"></td>
                `;
            }
            tbody.appendChild(tr);
        });
    }

    setupRouteTableListenersOnce() {
        const tbody = document.getElementById('routeTableBody');
        if (!tbody) return;
        const busId = this.currentBusId;
        const route = this.currentRoute || 'AM';

        tbody.addEventListener('input', (e) => {
            const input = e.target;
            if (!input.classList.contains('route-input')) return;
            const tr = input.closest('tr');
            if (!tr) return;
            const rowId = tr.dataset.rowId;
            if (input.classList.contains('route-student-input')) {
                this.onRouteStudentSearch(input, rowId);
                this.debouncedSaveRouteRowStudentName(rowId, input.value);
                return;
            }
            if (input.classList.contains('route-time')) {
                this.formatTimeAsYouType(input);
                this.debouncedSaveRouteRowField(rowId, 'time', input.value);
                return;
            }
            const field = input.dataset.field;
            if (field && field !== 'studentSearch') this.debouncedSaveRouteRowField(rowId, field, input.value);
        });

        tbody.addEventListener('change', (e) => {
            const input = e.target;
            if (!input.classList.contains('route-input')) return;
            const tr = input.closest('tr');
            if (!tr) return;
            const rowId = tr.dataset.rowId;
            if (input.classList.contains('route-time')) {
                this.formatTimeAsYouType(input);
                this.saveRouteRowField(rowId, 'time', input.value);
                return;
            }
            const field = input.dataset.field;
            if (field && field !== 'studentSearch') this.saveRouteRowField(rowId, field, input.value);
        });

        tbody.addEventListener('blur', (e) => {
            const input = e.target;
            const tr = input.closest('tr');
            const rowId = tr ? tr.dataset.rowId : null;
            if (input.classList.contains('route-student-input')) {
                const dropdown = input.closest('.route-student-cell')?.querySelector('[data-dropdown]');
                if (dropdown) setTimeout(() => { dropdown.classList.add('hidden'); dropdown.innerHTML = ''; }, 150);
                if (rowId) this.saveRouteRowStudentName(rowId, input.value);
            }
            if (!input.classList.contains('route-input')) return;
            if (!tr) return;
            if (input.classList.contains('route-time')) {
                this.formatTimeAsYouType(input);
                this.saveRouteRowField(rowId, 'time', input.value);
                return;
            }
            const field = input.dataset.field;
            if (field && field !== 'studentSearch') this.saveRouteRowField(rowId, field, input.value);
        });

        tbody.addEventListener('click', async (e) => {
            const target = e.target;
            const insertAboveBtn = target.closest('.route-insert-above');
            const insertBelowBtn = target.closest('.route-insert-below');
            if (insertAboveBtn) {
                e.preventDefault();
                const tr = insertAboveBtn.closest('tr');
                if (tr) {
                    const rows = await this.getRouteRows(this.currentBusId, this.currentRoute || 'AM');
                    const idx = rows.findIndex(r => r.id === tr.dataset.rowId);
                    if (idx !== -1) await this.insertRouteRowAtPosition(idx);
                }
            } else if (insertBelowBtn) {
                e.preventDefault();
                const tr = insertBelowBtn.closest('tr');
                if (tr) {
                    const rows = await this.getRouteRows(this.currentBusId, this.currentRoute || 'AM');
                    const idx = rows.findIndex(r => r.id === tr.dataset.rowId);
                    if (idx !== -1) await this.insertRouteRowAtPosition(idx + 1);
                }
            } else {
                const deleteBtn = target.closest('.route-delete-row');
                if (deleteBtn) {
                    e.preventDefault();
                    const tr = deleteBtn.closest('tr');
                    if (tr && confirm('Delete this row?')) await this.deleteRouteRowAndRefresh(tr.dataset.rowId);
                } else if (target.classList.contains('route-student-option')) {
                    e.preventDefault();
                    const rowId = target.closest('tr').dataset.rowId;
                    const studentId = target.dataset.studentId;
                    this.selectRouteStudent(rowId, studentId);
                }
            }
        });
    }

    _routeSaveDebounce = null;
    debouncedSaveRouteRowField(rowId, field, value) {
        if (this._routeSaveDebounce) clearTimeout(this._routeSaveDebounce);
        this._routeSaveDebounce = setTimeout(() => this.saveRouteRowField(rowId, field, value), 400);
    }

    _routeStudentNameDebounce = null;
    debouncedSaveRouteRowStudentName(rowId, value) {
        if (this._routeStudentNameDebounce) clearTimeout(this._routeStudentNameDebounce);
        this._routeStudentNameDebounce = setTimeout(() => this.saveRouteRowStudentName(rowId, value), 400);
    }

    async saveRouteRowStudentName(rowId, value) {
        const rows = await this.getRouteRows(this.currentBusId, this.currentRoute || 'AM');
        const row = rows.find(r => r.id === rowId);
        if (!row) return;
        row.studentName = (value || '').trim();
        row.studentId = '';
        await this.updateRouteRow(row);
    }

    async saveRouteRowField(rowId, field, value) {
        const rows = await this.getRouteRows(this.currentBusId, this.currentRoute || 'AM');
        const row = rows.find(r => r.id === rowId);
        if (!row) return;
        row[field] = value;
        await this.updateRouteRow(row);
    }

    onRouteStudentSearch(input, rowId) {
        const term = (input.value || '').trim().toLowerCase();
        const dropdown = input.closest('.route-student-cell')?.querySelector('[data-dropdown]');
        if (!dropdown) return;
        if (!term) {
            dropdown.classList.add('hidden');
            dropdown.innerHTML = '';
            return;
        }
        const matches = this.students.filter(s => {
            const name = this.getStudentDisplayName(s).toLowerCase();
            const first = (s.firstName || '').toLowerCase();
            const last = (s.lastName || '').toLowerCase();
            return name.includes(term) || first.includes(term) || last.includes(term);
        }).slice(0, 8);
        dropdown.innerHTML = matches.map(s => `
            <div class="route-student-option" data-student-id="${s.id}" role="button">${this.escapeHtml(this.getStudentDisplayName(s))}</div>
        `).join('') || '<div class="route-student-option-empty">No students found</div>';
        dropdown.classList.remove('hidden');
        requestAnimationFrame(() => {
            dropdown.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        });
    }

    async selectRouteStudent(rowId, studentId) {
        const student = this.students.find(s => s.id === studentId);
        if (!student) return;
        const address = (student.dropoffAddress || student.address || '').trim();
        const rows = await this.getRouteRows(this.currentBusId, this.currentRoute || 'AM');
        const row = rows.find(r => r.id === rowId);
        if (!row) return;
        row.studentId = studentId;
        row.streetAddress = address;
        const atAddress = this.getStudentsAtAddress(address);
        row.studentName = atAddress.length > 0
            ? atAddress.map(s => this.getStudentDisplayName(s)).filter(Boolean).join(', ')
            : this.getStudentDisplayName(student);
        await this.updateRouteRow(row);
        const tr = document.querySelector(`#routeTableBody tr[data-row-id="${rowId}"]`);
        if (tr) {
            tr.querySelector('.route-student-input').value = row.studentName;
            tr.querySelector('.route-student-id').value = studentId;
            tr.querySelector('.route-address').value = address;
            tr.querySelector('[data-dropdown]').classList.add('hidden');
            tr.querySelector('[data-dropdown]').innerHTML = '';
        }
    }

    async deleteRouteRowAndRefresh(rowId) {
        await this.deleteRouteRow(rowId);
        await this.renderRouteTable();
    }

    async insertRouteRowAtPosition(insertIndex) {
        const busId = this.currentBusId;
        const route = this.currentRoute || 'AM';
        const rows = await this.getRouteRows(busId, route);
        const newRow = {
            busId,
            route,
            order: insertIndex,
            action: '',
            direction: '',
            streetAddress: '',
            studentId: '',
            studentName: '',
            roadside: '',
            time: ''
        };
        const toShift = rows.filter(r => (r.order ?? 0) >= insertIndex).sort((a, b) => (b.order ?? 0) - (a.order ?? 0));
        for (const r of toShift) {
            r.order = (r.order ?? 0) + 1;
            await this.updateRouteRow(r);
        }
        await this.addRouteRow(newRow);
        await this.renderRouteTable();
    }

    async addRouteModalRow() {
        const busId = this.currentBusId;
        const route = this.currentRoute || 'AM';
        const rows = await this.getRouteRows(busId, route);
        await this.addRouteRow({
            busId,
            route,
            order: rows.length,
            action: '',
            direction: '',
            streetAddress: '',
            studentId: '',
            studentName: '',
            roadside: '',
            time: ''
        });
        await this.renderRouteTable();
        const wrapper = document.querySelector('.route-table-wrapper');
        if (wrapper) {
            wrapper.scrollTop = wrapper.scrollHeight;
        }
    }

    openCheckinHistoryModal() {
        this.closeCheckinModal();
        
        // Set today's date as default
        const today = new Date().toISOString().split('T')[0];
        document.getElementById('checkinHistoryDateInput').value = today;
        
        // Populate bus select
        const busSelect = document.getElementById('checkinHistoryBusSelect');
        busSelect.innerHTML = '<option value="">All Busses</option>' + 
            this.busses.map(bus => `<option value="${bus.id}">${this.escapeHtml(bus.name)}</option>`).join('');
        
        document.getElementById('checkinHistoryModal').style.display = 'block';
    }

    closeCheckinHistoryModal() {
        document.getElementById('checkinHistoryModal').style.display = 'none';
    }

    async loadCheckinHistory() {
        const date = document.getElementById('checkinHistoryDateInput').value;
        const busId = document.getElementById('checkinHistoryBusSelect').value;
        const route = document.getElementById('checkinHistoryRouteSelect').value;
        
        if (!date) {
            alert('Please select a date');
            return;
        }
        
        // Get all check-ins for the date
        let allCheckins = [];
        if (busId && route) {
            allCheckins = await this.getCheckinsForDate(busId, date, route);
        } else {
            // Get all check-ins for the date
            allCheckins = this.checkins.filter(c => c.date === date);
            if (busId) {
                allCheckins = allCheckins.filter(c => c.busId === busId);
            }
            if (route) {
                allCheckins = allCheckins.filter(c => c.route === route);
            }
        }
        
        // Group by bus and route
        const grouped = {};
        allCheckins.forEach(checkin => {
            const key = `${checkin.busId}-${checkin.route}`;
            if (!grouped[key]) {
                grouped[key] = {
                    bus: this.busses.find(b => b.id === checkin.busId),
                    route: checkin.route,
                    checkins: []
                };
            }
            grouped[key].checkins.push(checkin);
        });
        
        // Store current history data for export
        this.currentHistoryData = {
            date: date,
            busId: busId,
            route: route,
            grouped: grouped
        };
        
        // Display results
        const container = document.getElementById('checkinHistoryResults');
        const exportButtons = document.getElementById('checkinHistoryExportButtons');
        
        if (Object.keys(grouped).length === 0) {
            container.innerHTML = '<p style="text-align: center; color: var(--text-secondary); padding: 40px;">No check-ins found for this date.</p>';
            exportButtons.style.display = 'none';
            return;
        }
        
        exportButtons.style.display = 'block';
        
        container.innerHTML = Object.values(grouped).map(group => {
            const checkedInStudents = group.checkins.map(c => {
                const student = this.students.find(s => s.id === c.studentId);
                const displayName = student ? (student.firstName && student.lastName ? `${student.firstName} ${student.lastName}` : student.name) : 'Unknown';
                return {
                    name: displayName,
                    time: new Date(c.timestamp).toLocaleTimeString(),
                    isExtra: c.isExtra || false
                };
            });
            
            return `
                <div style="margin-bottom: 20px; padding: 15px; background: var(--card-bg); border-radius: 8px; box-shadow: var(--shadow);">
                    <h3 style="margin-bottom: 10px; color: var(--text-primary);">
                        ${this.escapeHtml(group.bus ? group.bus.name : 'Unknown Bus')} - ${group.route} Route
                    </h3>
                    <div style="font-size: 14px; color: var(--text-secondary); margin-bottom: 10px;">
                        ${checkedInStudents.length} student(s) checked in
                    </div>
                    <div style="max-height: 300px; overflow-y: auto;">
                        ${checkedInStudents.map(s => `
                            <div style="padding: 8px; border-bottom: 1px solid var(--border-color); display: flex; justify-content: space-between; align-items: center; ${s.isExtra ? 'border-left: 4px solid #FF9800;' : ''}">
                                <div style="display: flex; align-items: center; gap: 8px;">
                                    <span>${this.escapeHtml(s.name)}</span>
                                    ${s.isExtra ? '<span style="background: #FF9800; color: white; padding: 2px 8px; border-radius: 4px; font-size: 11px; font-weight: 600;">EXTRA</span>' : ''}
                                </div>
                                <span style="color: var(--text-secondary);">${s.time}</span>
                            </div>
                        `).join('')}
                    </div>
                </div>
            `;
        }).join('');
    }

    exportCheckinToPDF() {
        if (!this.currentHistoryData || !this.currentHistoryData.grouped) {
            alert('Please load check-in history first');
            return;
        }

        const { date, grouped } = this.currentHistoryData;
        const dateStr = new Date(date).toLocaleDateString();
        
        // Create HTML content for PDF
        let htmlContent = `
            <!DOCTYPE html>
            <html>
            <head>
                <title>Check-In Report - ${dateStr}</title>
                <style>
                    body { font-family: Arial, sans-serif; padding: 20px; }
                    h1 { color: #333; border-bottom: 2px solid #4169E1; padding-bottom: 10px; }
                    h2 { color: #555; margin-top: 30px; }
                    table { width: 100%; border-collapse: collapse; margin-top: 15px; }
                    th { background-color: #4169E1; color: white; padding: 10px; text-align: left; }
                    td { padding: 8px; border-bottom: 1px solid #ddd; }
                    tr:nth-child(even) { background-color: #f2f2f2; }
                    .summary { margin-top: 20px; padding: 15px; background-color: #f9f9f9; border-left: 4px solid #4169E1; }
                </style>
            </head>
            <body>
                <h1>Check-In Report</h1>
                <p><strong>Date:</strong> ${dateStr}</p>
        `;
        
        Object.values(grouped).forEach(group => {
            const busName = group.bus ? group.bus.name : 'Unknown Bus';
            const checkedInStudents = group.checkins.map(c => {
                const student = this.students.find(s => s.id === c.studentId);
                const displayName = student ? (student.firstName && student.lastName ? `${student.firstName} ${student.lastName}` : student.name) : 'Unknown';
                const time = new Date(c.timestamp).toLocaleTimeString();
                return { name: displayName, time: time, isExtra: c.isExtra || false };
            });
            
            htmlContent += `
                <h2>${this.escapeHtml(busName)} - ${group.route} Route</h2>
                <div class="summary">
                    <strong>Total Students Checked In:</strong> ${checkedInStudents.length}
                </div>
                <table>
                    <thead>
                        <tr>
                            <th>#</th>
                            <th>Student Name</th>
                            <th>Check-In Time</th>
                            <th>Status</th>
                        </tr>
                    </thead>
                    <tbody>
            `;
            
            checkedInStudents.forEach((s, index) => {
                htmlContent += `
                    <tr>
                        <td>${index + 1}</td>
                        <td>${this.escapeHtml(s.name)}</td>
                        <td>${s.time}</td>
                        <td>${s.isExtra ? '<strong style="color: #FF9800;">EXTRA</strong>' : '-'}</td>
                    </tr>
                `;
            });
            
            htmlContent += `
                    </tbody>
                </table>
            `;
        });
        
        htmlContent += `
            </body>
            </html>
        `;
        
        // Open in new window and print
        const printWindow = window.open('', '_blank');
        printWindow.document.write(htmlContent);
        printWindow.document.close();
        
        // Wait for content to load, then trigger print
        setTimeout(() => {
            printWindow.print();
        }, 250);
    }

    exportCheckinToExcel() {
        if (!this.currentHistoryData || !this.currentHistoryData.grouped) {
            alert('Please load check-in history first');
            return;
        }

        const { date, grouped } = this.currentHistoryData;
        const dateStr = new Date(date).toLocaleDateString();
        
        // Create CSV content (Excel can open CSV)
        let csvContent = `Check-In Report - ${dateStr}\n\n`;
        
        Object.values(grouped).forEach(group => {
            const busName = group.bus ? group.bus.name : 'Unknown Bus';
            csvContent += `${busName} - ${group.route} Route\n`;
            csvContent += `Student Name,Check-In Time,Status\n`;
            
            const checkedInStudents = group.checkins.map(c => {
                const student = this.students.find(s => s.id === c.studentId);
                const displayName = student ? (student.firstName && student.lastName ? `${student.firstName} ${student.lastName}` : student.name) : 'Unknown';
                const time = new Date(c.timestamp).toLocaleTimeString();
                return { name: displayName, time: time, isExtra: c.isExtra || false };
            });
            
            checkedInStudents.forEach(s => {
                // Escape commas and quotes in CSV
                const name = s.name.replace(/"/g, '""');
                const status = s.isExtra ? 'EXTRA' : '';
                csvContent += `"${name}","${s.time}","${status}"\n`;
            });
            
            csvContent += `Total,${checkedInStudents.length}\n\n`;
        });
        
        // Create and download CSV
        const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `CheckIn_Report_${date.replace(/-/g, '_')}.csv`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    }

    // Utility Functions
    escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }
}

// Initialize app
let app;
document.addEventListener('DOMContentLoaded', () => {
    app = new BusStudentTracker();
    
    // Register service worker (?v= uses APP_VERSION so new deploys get fresh SW)
    if ('serviceWorker' in navigator) {
        navigator.serviceWorker.register('./service-worker.js?v=' + APP_VERSION).then(registration => {
            console.log('Service Worker registered:', registration);
        }).catch(error => {
            console.error('Service Worker registration failed:', error);
        });
    }
});
