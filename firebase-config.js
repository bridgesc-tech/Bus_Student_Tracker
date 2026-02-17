// Firebase Configuration for Bus Student Tracker
// Using the same Firebase project as other apps

const firebaseConfig = {
    apiKey: "AIzaSyDK15y-JQrDozJ3aXxFClXSVuniRjcULlE",
    authDomain: "tv-time-management.firebaseapp.com",
    projectId: "tv-time-management",
    storageBucket: "tv-time-management.firebasestorage.app",
    messagingSenderId: "836553253045",
    appId: "1:836553253045:web:e93f536adf7afbbced5efc"
};

// Initialize Firebase (only if Firebase scripts are loaded)
let db = null;

async function initializeFirebaseIfReady() {
    if (typeof firebase !== 'undefined' && window.location.protocol !== 'file:') {
        try {
            console.log('Initializing Firebase for Bus Student Tracker...');
            firebase.initializeApp(firebaseConfig);
            db = firebase.firestore();
            
            // Authenticate with anonymous auth (required for Firestore security rules)
            const auth = firebase.auth();
            try {
                const userCredential = await auth.signInAnonymously();
                console.log('Authenticated anonymously:', userCredential.user.uid);
            } catch (authError) {
                console.error('Error authenticating:', authError);
                const currentUser = auth.currentUser;
                if (!currentUser) {
                    console.warn('Could not authenticate with Firebase. Some features may not work.');
                }
            }
            
            // Expose db on window for app to access
            window.db = db;
            console.log('Firebase initialized successfully, db:', db);
            window.dispatchEvent(new CustomEvent('firebaseReady'));
        } catch (error) {
            console.error('Firebase initialization error:', error);
        }
    } else {
        if (window.location.protocol === 'file:') {
            console.log('Running from file:// - Firebase disabled');
        } else {
            if (typeof firebase === 'undefined') {
                setTimeout(initializeFirebaseIfReady, 100);
            }
        }
    }
}

// Try to initialize immediately, or wait for scripts
if (typeof firebase !== 'undefined' && window.location.protocol !== 'file:') {
    initializeFirebaseIfReady();
} else if (window.location.protocol !== 'file:') {
    setTimeout(initializeFirebaseIfReady, 200);
} else {
    console.log('Running from file:// - Firebase disabled');
}
