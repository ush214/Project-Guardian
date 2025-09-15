/**
 * Monitoring Dashboard JavaScript
 * 
 * Handles the monitoring dashboard UI for visualizing events,
 * managing alerts, and triggering manual scans.
 */

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import { 
  getFirestore, 
  collection, 
  query, 
  orderBy, 
  limit, 
  where,
  onSnapshot,
  doc,
  updateDoc,
  getDocs,
  collectionGroup
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

// Initialize Firebase
const app = initializeApp(window.firebaseConfig);
const db = getFirestore(app);

// Read collections
const READ_COLLECTIONS = [
  "artifacts/guardian/public/data/werpassessments",
  "artifacts/guardian-agent-default/public/data/werpassessments"
];

class MonitoringDashboard {
  constructor() {
    this.eventsListener = null;
    this.alertsListener = null;
    this.currentFilter = 'all';
    this.init();
  }

  async init() {
    this.setupEventListeners();
    await this.loadWrecks();
    this.startRealtimeListeners();
    this.checkSystemStatus();
    
    // Refresh every 5 minutes
    setInterval(() => {
      this.checkSystemStatus();
      this.updateLastUpdateTime();
    }, 5 * 60 * 1000);
  }

  setupEventListeners() {
    // Event controls
    document.getElementById('refresh-events').addEventListener('click', () => {
      this.refreshEvents();
    });
    
    document.getElementById('event-filter').addEventListener('change', (e) => {
      this.currentFilter = e.target.value;
      this.refreshEvents();
    });

    // Alert controls
    document.getElementById('refresh-alerts').addEventListener('click', () => {
      this.refreshAlerts();
    });
    
    document.getElementById('acknowledge-all').addEventListener('click', () => {
      this.acknowledgeAllAlerts();
    });

    // Status controls
    document.getElementById('refresh-status').addEventListener('click', () => {
      this.checkSystemStatus();
    });

    // Manual action controls
    document.getElementById('trigger-earthquake-scan').addEventListener('click', () => {
      this.triggerScan('earthquakes');
    });
    
    document.getElementById('trigger-storm-scan').addEventListener('click', () => {
      this.triggerScan('storms');
    });
    
    document.getElementById('trigger-oil-scan').addEventListener('click', () => {
      this.triggerScan('oil');
    });
    
    document.getElementById('scan-selected-wreck').addEventListener('click', () => {
      this.scanSelectedWreck();
    });
  }

  async loadWrecks() {
    const wreckSelector = document.getElementById('wreck-selector');
    wreckSelector.innerHTML = '<option value="">Loading wrecks...</option>';
    
    try {
      const wrecks = [];
      
      for (const collectionPath of READ_COLLECTIONS) {
        const querySnapshot = await getDocs(collection(db, collectionPath));
        querySnapshot.forEach(doc => {
          const data = doc.data();
          wrecks.push({
            id: doc.id,
            collection: collectionPath,
            name: data.name || data.vesselName || `Wreck ${doc.id}`,
            coordinates: this.extractCoordinates(data)
          });
        });
      }
      
      wreckSelector.innerHTML = '<option value="">Select a wreck...</option>';
      wrecks.forEach(wreck => {
        const option = document.createElement('option');
        option.value = JSON.stringify({
          id: wreck.id,
          collection: wreck.collection,
          coordinates: wreck.coordinates
        });
        option.textContent = `${wreck.name} (${wreck.id})`;
        wreckSelector.appendChild(option);
      });
      
    } catch (error) {
      console.error('Error loading wrecks:', error);
      wreckSelector.innerHTML = '<option value="">Error loading wrecks</option>';
    }
  }

  extractCoordinates(data) {
    // Try various coordinate field paths
    const coordPaths = [
      ['coordinates'],
      ['location', 'coordinates'],
      ['historical', 'location', 'coordinates'],
      ['geometry', 'coordinates']
    ];

    for (const path of coordPaths) {
      let coords = data;
      for (const key of path) {
        if (coords && typeof coords === 'object' && key in coords) {
          coords = coords[key];
        } else {
          coords = null;
          break;
        }
      }
      
      if (coords && typeof coords === 'object') {
        if (typeof coords.lat === 'number' && (typeof coords.lon === 'number' || typeof coords.lng === 'number')) {
          return {
            lat: coords.lat,
            lon: coords.lon || coords.lng
          };
        }
      }
    }
    
    return null;
  }

  startRealtimeListeners() {
    this.refreshEvents();
    this.refreshAlerts();
  }

  async refreshEvents() {
    const eventsList = document.getElementById('events-list');
    const eventsLoading = document.getElementById('events-loading');
    const eventsEmpty = document.getElementById('events-empty');
    
    eventsLoading.style.display = 'block';
    eventsList.style.display = 'none';
    eventsEmpty.style.display = 'none';
    
    try {
      const events = [];
      
      // Query monitoring events from both collections
      for (const collectionPath of READ_COLLECTIONS) {
        // Query events based on filter
        let eventTypes = ['earthquakes', 'storms', 'oil'];
        if (this.currentFilter !== 'all') {
          eventTypes = [this.currentFilter];
        }
        
        for (const eventType of eventTypes) {
          try {
            const eventsRef = collectionGroup(db, 'events');
            const q = query(
              eventsRef,
              orderBy('createdAtMs', 'desc'),
              limit(50)
            );
            
            const querySnapshot = await getDocs(q);
            querySnapshot.forEach(doc => {
              const data = doc.data();
              const parentPath = doc.ref.parent.parent.parent.parent.path;
              
              if (parentPath.includes(collectionPath) && doc.ref.parent.parent.id === eventType) {
                events.push({
                  ...data,
                  id: doc.id,
                  type: eventType,
                  wreckId: doc.ref.parent.parent.parent.id,
                  collection: collectionPath
                });
              }
            });
          } catch (error) {
            console.warn(`Error querying ${eventType} events:`, error);
          }
        }
      }
      
      // Sort by creation time
      events.sort((a, b) => (b.createdAtMs || 0) - (a.createdAtMs || 0));
      
      if (events.length === 0) {
        eventsLoading.style.display = 'none';
        eventsEmpty.style.display = 'block';
        return;
      }
      
      // Render events
      eventsList.innerHTML = '';
      events.slice(0, 20).forEach(event => {
        const eventItem = this.createEventItem(event);
        eventsList.appendChild(eventItem);
      });
      
      eventsLoading.style.display = 'none';
      eventsList.style.display = 'block';
      
    } catch (error) {
      console.error('Error loading events:', error);
      eventsLoading.style.display = 'none';
      eventsEmpty.style.display = 'block';
      eventsEmpty.innerHTML = '<p>Error loading events</p>';
    }
  }

  createEventItem(event) {
    const li = document.createElement('li');
    li.className = 'event-item';
    
    const icon = this.getEventIcon(event.type);
    const severity = this.getEventSeverity(event);
    const time = event.createdAtMs ? new Date(event.createdAtMs).toLocaleString() : 'Unknown time';
    
    li.innerHTML = `
      <div class="event-header">
        <div class="event-type">
          <span class="event-icon">${icon}</span>
          <span>${this.capitalizeFirst(event.type)}</span>
        </div>
        <span class="event-severity ${severity.class}">${severity.text}</span>
      </div>
      <div class="event-details">
        ${event.message || 'No message available'}
      </div>
      <div class="event-meta">
        <span>🏗️ ${event.wreckId}</span>
        <span>📅 ${time}</span>
        ${event.distanceKm ? `<span>📍 ${event.distanceKm}km</span>` : ''}
        ${event.magnitude ? `<span>📊 M${event.magnitude}</span>` : ''}
        ${event.windSpeed ? `<span>💨 ${event.windSpeed}mph</span>` : ''}
      </div>
    `;
    
    return li;
  }

  getEventIcon(type) {
    const icons = {
      earthquakes: '🌋',
      storms: '🌀', 
      oil: '🛢️'
    };
    return icons[type] || '⚑';
  }

  getEventSeverity(event) {
    if (event.exceeded) {
      return { class: 'severity-high', text: 'High' };
    } else if (event.magnitude >= 6 || event.windSpeed >= 100 || event.distanceKm <= 50) {
      return { class: 'severity-medium', text: 'Medium' };
    } else {
      return { class: 'severity-low', text: 'Low' };
    }
  }

  async refreshAlerts() {
    const alertsList = document.getElementById('alerts-list');
    const alertsLoading = document.getElementById('alerts-loading');
    const alertsEmpty = document.getElementById('alerts-empty');
    
    alertsLoading.style.display = 'block';
    alertsList.style.display = 'none';
    alertsEmpty.style.display = 'none';
    
    try {
      const alerts = [];
      
      // Query for wrecks with alerts
      for (const collectionPath of READ_COLLECTIONS) {
        const wrecksRef = collection(db, collectionPath);
        const q = query(wrecksRef, where('needsReassessment', '==', true));
        
        const querySnapshot = await getDocs(q);
        querySnapshot.forEach(doc => {
          const data = doc.data();
          if (data.alerts && Array.isArray(data.alerts)) {
            data.alerts.forEach(alert => {
              if (!alert.acknowledged) {
                alerts.push({
                  ...alert,
                  wreckId: doc.id,
                  wreckName: data.name || data.vesselName || doc.id,
                  collection: collectionPath
                });
              }
            });
          }
        });
      }
      
      if (alerts.length === 0) {
        alertsLoading.style.display = 'none';
        alertsEmpty.style.display = 'block';
        return;
      }
      
      // Sort by creation time
      alerts.sort((a, b) => {
        const aTime = a.createdAt?.seconds || 0;
        const bTime = b.createdAt?.seconds || 0;
        return bTime - aTime;
      });
      
      // Render alerts
      alertsList.innerHTML = '';
      alerts.forEach(alert => {
        const alertItem = this.createAlertItem(alert);
        alertsList.appendChild(alertItem);
      });
      
      alertsLoading.style.display = 'none';
      alertsList.style.display = 'block';
      
    } catch (error) {
      console.error('Error loading alerts:', error);
      alertsLoading.style.display = 'none';
      alertsEmpty.style.display = 'block';
      alertsEmpty.innerHTML = '<p>Error loading alerts</p>';
    }
  }

  createAlertItem(alert) {
    const div = document.createElement('div');
    div.className = `alert-item ${alert.acknowledged ? 'acknowledged' : ''}`;
    
    const time = alert.createdAt ? new Date(alert.createdAt.seconds * 1000).toLocaleString() : 'Unknown time';
    
    div.innerHTML = `
      <div class="alert-header">
        <div class="alert-message">${alert.message}</div>
      </div>
      <div class="event-meta">
        <span>🏗️ ${alert.wreckName} (${alert.wreckId})</span>
        <span>📅 ${time}</span>
        <span>🏷️ ${alert.type}</span>
      </div>
      <div class="alert-actions">
        <button class="btn" onclick="window.dashboard.acknowledgeAlert('${alert.wreckId}', '${alert.id}', '${alert.collection}')">
          ✓ Acknowledge
        </button>
      </div>
    `;
    
    return div;
  }

  async acknowledgeAlert(wreckId, alertId, collectionPath) {
    try {
      const wreckRef = doc(db, collectionPath, wreckId);
      const wreckDoc = await wreckRef.get();
      
      if (wreckDoc.exists()) {
        const data = wreckDoc.data();
        const alerts = data.alerts || [];
        
        // Update the specific alert
        const updatedAlerts = alerts.map(alert => {
          if (alert.id === alertId) {
            return { ...alert, acknowledged: true, acknowledgedAt: new Date() };
          }
          return alert;
        });
        
        // Check if all alerts are acknowledged
        const allAcknowledged = updatedAlerts.every(alert => alert.acknowledged);
        
        await updateDoc(wreckRef, {
          alerts: updatedAlerts,
          needsReassessment: !allAcknowledged
        });
        
        this.refreshAlerts();
      }
    } catch (error) {
      console.error('Error acknowledging alert:', error);
      alert('Failed to acknowledge alert');
    }
  }

  async acknowledgeAllAlerts() {
    if (!confirm('Are you sure you want to acknowledge all active alerts?')) {
      return;
    }
    
    try {
      for (const collectionPath of READ_COLLECTIONS) {
        const wrecksRef = collection(db, collectionPath);
        const q = query(wrecksRef, where('needsReassessment', '==', true));
        
        const querySnapshot = await getDocs(q);
        const updatePromises = [];
        
        querySnapshot.forEach(doc => {
          const data = doc.data();
          if (data.alerts && Array.isArray(data.alerts)) {
            const updatedAlerts = data.alerts.map(alert => ({
              ...alert,
              acknowledged: true,
              acknowledgedAt: new Date()
            }));
            
            updatePromises.push(
              updateDoc(doc.ref, {
                alerts: updatedAlerts,
                needsReassessment: false
              })
            );
          }
        });
        
        await Promise.all(updatePromises);
      }
      
      this.refreshAlerts();
      
    } catch (error) {
      console.error('Error acknowledging all alerts:', error);
      alert('Failed to acknowledge all alerts');
    }
  }

  async checkSystemStatus() {
    // Update processor status
    try {
      const response = await fetch('/api/monitoring-processor/health');
      const status = document.getElementById('processor-status');
      if (response.ok) {
        status.textContent = 'Online';
        status.previousElementSibling.className = 'status-indicator status-active';
      } else {
        status.textContent = 'Offline';
        status.previousElementSibling.className = 'status-indicator status-error';
      }
    } catch (error) {
      const status = document.getElementById('processor-status');
      status.textContent = 'Offline';
      status.previousElementSibling.className = 'status-indicator status-error';
    }
    
    // Update spill detector status
    try {
      const response = await fetch('/api/oil-spill-detector/health');
      const status = document.getElementById('spill-detector-status');
      if (response.ok) {
        status.textContent = 'Online';
        status.previousElementSibling.className = 'status-indicator status-active';
      } else {
        status.textContent = 'Offline';
        status.previousElementSibling.className = 'status-indicator status-error';
      }
    } catch (error) {
      const status = document.getElementById('spill-detector-status');
      status.textContent = 'Offline';
      status.previousElementSibling.className = 'status-indicator status-error';
    }
    
    // Firebase Functions status (assume online if we can query Firestore)
    const functionsStatus = document.getElementById('functions-status');
    functionsStatus.textContent = 'Online';
    functionsStatus.previousElementSibling.className = 'status-indicator status-active';
    
    this.updateLastUpdateTime();
  }

  updateLastUpdateTime() {
    document.getElementById('last-update').textContent = new Date().toLocaleTimeString();
  }

  async triggerScan(type) {
    const button = document.getElementById(`trigger-${type}-scan`);
    const originalText = button.textContent;
    
    button.disabled = true;
    button.textContent = 'Scanning...';
    
    try {
      let endpoint;
      switch (type) {
        case 'earthquakes':
          endpoint = '/api/monitoring-processor/process-earthquakes';
          break;
        case 'storms':
          endpoint = '/api/monitoring-processor/process-storms';
          break;
        case 'oil':
          endpoint = '/api/oil-spill-detector/process-all';
          break;
      }
      
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({})
      });
      
      if (response.ok) {
        const result = await response.json();
        alert(`${type} scan completed successfully! Processed: ${result.processed || result.wrecks || 0} items`);
        this.refreshEvents();
        this.refreshAlerts();
      } else {
        throw new Error(`HTTP ${response.status}`);
      }
      
    } catch (error) {
      console.error(`Error triggering ${type} scan:`, error);
      alert(`Failed to trigger ${type} scan: ${error.message}`);
    } finally {
      button.disabled = false;
      button.textContent = originalText;
    }
  }

  async scanSelectedWreck() {
    const selector = document.getElementById('wreck-selector');
    const button = document.getElementById('scan-selected-wreck');
    
    if (!selector.value) {
      alert('Please select a wreck first');
      return;
    }
    
    const wreckData = JSON.parse(selector.value);
    
    if (!wreckData.coordinates) {
      alert('Selected wreck has no coordinates');
      return;
    }
    
    const originalText = button.textContent;
    button.disabled = true;
    button.textContent = 'Scanning...';
    
    try {
      // Trigger oil spill detection for the selected wreck
      const response = await fetch('/api/oil-spill-detector/process-wreck', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          wreckId: wreckData.id,
          wreckCoords: [wreckData.coordinates.lat, wreckData.coordinates.lon]
        })
      });
      
      if (response.ok) {
        const result = await response.json();
        alert(`Scan completed for ${wreckData.id}! Spills detected: ${result.spills_detected || 0}`);
        this.refreshEvents();
        this.refreshAlerts();
      } else {
        throw new Error(`HTTP ${response.status}`);
      }
      
    } catch (error) {
      console.error('Error scanning selected wreck:', error);
      alert(`Failed to scan wreck: ${error.message}`);
    } finally {
      button.disabled = false;
      button.textContent = originalText;
    }
  }

  capitalizeFirst(str) {
    return str.charAt(0).toUpperCase() + str.slice(1);
  }
}

// Initialize dashboard when page loads
document.addEventListener('DOMContentLoaded', () => {
  window.dashboard = new MonitoringDashboard();
});