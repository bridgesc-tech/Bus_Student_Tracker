# Bus Student Tracker

A Progressive Web App (PWA) for tracking student bus seating assignments on Android tablets.

## Features

- **Bus Management**: Create and manage multiple busses
- **Visual Seating Diagram**: Interactive bus diagram with 16 rows of seats (6 seats per row - 3 on each side)
- **Student Assignment**: Assign students to specific seats by clicking empty seats
- **Student Information**: View student details including name, grade, address, and parent contact information
- **Student Search**: Search and filter students when assigning to seats
- **CSV Import**: Import student data from CSV files
- **Firebase Sync**: Sync data across devices using Firebase
- **Offline Support**: Works offline using IndexedDB for local storage

## Bus Layout

- **12 Rows** of seats
- **4 Seats per row** (2 on left side, 2 on right side)
- **Driver seat** positioned at the bottom right of the diagram

## Student Data

Student information can be imported from a CSV file. The app will attempt to detect columns for:
- Student Name
- Grade Level
- Address
- Parent Contact Information

## Firebase Integration

The app connects to the same Firebase account as other apps in this folder. Data is synced using a unique sync ID that can be shared between devices.

## Installation

1. Clone or download this repository
2. (Optional) Generate PWA icons: open **create_icons.html** in a browser, save `icon-192.png` and `icon-512.png` into the project folder
3. Serve the files over **HTTPS** (required for PWA install and Firebase). For example: GitHub Pages, Netlify, or a local HTTPS server
4. Open the app URL in a browser or use **Add to Home Screen** / **Install app** on mobile devices

For detailed steps to push to GitHub and install on mobile, see **[DEPLOY.md](DEPLOY.md)**.

## Usage

1. **Create a Bus**: Click "Create Bus" on the main screen
2. **Open a Bus**: Click on any bus card to view its seating diagram
3. **Assign Students**: Click on an empty seat, then search for and select a student
4. **View Student Info**: Click on an occupied seat to view student details
5. **Unassign Students**: Click "Unassign from Seat" in the student info modal
6. **Import Students**: Go to Settings and click "Import Students from CSV"

## Technical Details

- Built with vanilla JavaScript
- Uses IndexedDB for local storage
- Firebase Firestore for cloud sync
- Service Worker for offline support and updates
- Responsive design optimized for Android tablets in landscape orientation

## Version

1.0.6
