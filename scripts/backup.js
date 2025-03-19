#!/usr/bin/env node

/**
 * SSH Client Backup Script
 * 
 * This script creates a backup of the SSH Client data directory,
 * which contains saved connections, API keys, and chat history.
 */

const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const archiver = require('archiver');

// Get current date in YYYY-MM-DD format
const today = new Date().toISOString().split('T')[0];
const timestamp = new Date().toISOString().replace(/:/g, '-').replace(/\..+/, '');

// Create backups directory if it doesn't exist
const backupsDir = path.join(process.cwd(), 'backups');
if (!fs.existsSync(backupsDir)) {
  fs.mkdirSync(backupsDir);
}

// Define backup filename
const backupFilename = `ssh-client-backup-${timestamp}.zip`;
const backupPath = path.join(backupsDir, backupFilename);

// Create a file to stream archive data to
const output = fs.createWriteStream(backupPath);
const archive = archiver('zip', {
  zlib: { level: 9 } // Sets the compression level
});

// Listen for all archive data to be written
output.on('close', function() {
  console.log(`✅ Backup created successfully: ${backupPath}`);
  console.log(`   Total size: ${(archive.pointer() / 1024 / 1024).toFixed(2)} MB`);
  
  // Check if older backups should be pruned
  pruneOldBackups();
});

// Good practice to catch warnings
archive.on('warning', function(err) {
  if (err.code === 'ENOENT') {
    console.warn('⚠️  Warning during backup:', err.message);
  } else {
    throw err;
  }
});

// Good practice to catch this error explicitly
archive.on('error', function(err) {
  console.error('❌ Error creating backup:', err);
  process.exit(1);
});

// Pipe archive data to the file
archive.pipe(output);

// Add the data directory to the archive
const dataDir = path.join(process.cwd(), 'data');
if (fs.existsSync(dataDir)) {
  archive.directory(dataDir, 'data');
  console.log('📂 Adding data directory to backup...');
} else {
  console.warn('⚠️  Data directory not found, creating empty directory in backup');
  archive.append(null, { name: 'data/.gitkeep' });
}

// Add .env file if it exists
const envFile = path.join(process.cwd(), '.env');
if (fs.existsSync(envFile)) {
  archive.file(envFile, { name: '.env' });
  console.log('📄 Adding .env file to backup...');
} else {
  console.warn('⚠️  .env file not found, skipping');
}

// Add package.json for version reference
const packageFile = path.join(process.cwd(), 'package.json');
if (fs.existsSync(packageFile)) {
  archive.file(packageFile, { name: 'package.json' });
  console.log('📄 Adding package.json to backup for version reference...');
}

// Add any logs (if they exist)
const logFiles = ['access.log', 'error.log'];
for (const logFile of logFiles) {
  const logPath = path.join(process.cwd(), logFile);
  if (fs.existsSync(logPath)) {
    archive.file(logPath, { name: `logs/${logFile}` });
    console.log(`📄 Adding ${logFile} to backup...`);
  }
}

// Finalize the archive
archive.finalize();

/**
 * Prune old backups, keeping:
 * - All backups from the last 7 days
 * - Weekly backups for the last month
 * - Monthly backups for everything older
 */
function pruneOldBackups() {
  fs.readdir(backupsDir, (err, files) => {
    if (err) {
      console.error('❌ Error reading backups directory:', err);
      return;
    }
    
    // Filter only backup files
    const backups = files
      .filter(file => file.startsWith('ssh-client-backup-') && file.endsWith('.zip'))
      .map(file => {
        try {
          // Extract date from filename
          const dateStr = file.replace('ssh-client-backup-', '').replace('.zip', '');
          return {
            file,
            path: path.join(backupsDir, file),
            date: new Date(dateStr.split('T')[0]),
            timestamp: new Date(dateStr.replace(/-/g, ':') + 'Z')
          };
        } catch (e) {
          return null;
        }
      })
      .filter(backup => backup !== null)
      .sort((a, b) => b.timestamp - a.timestamp); // Sort newest first
    
    if (backups.length <= 7) {
      console.log(`🧹 Only ${backups.length} backups found, no pruning needed`);
      return;
    }
    
    console.log(`🧹 Found ${backups.length} backups, checking for old backups to prune...`);
    
    const now = new Date();
    const sevenDaysAgo = new Date(now);
    sevenDaysAgo.setDate(now.getDate() - 7);
    
    const oneMonthAgo = new Date(now);
    oneMonthAgo.setMonth(now.getMonth() - 1);
    
    // Separate backups into categories
    const recentBackups = backups.filter(b => b.timestamp >= sevenDaysAgo);
    const olderBackups = backups.filter(b => b.timestamp < sevenDaysAgo);
    
    console.log(`   - ${recentBackups.length} backups within the last 7 days (keeping all)`);
    
    // Keep all recent backups
    const toKeep = new Set(recentBackups.map(b => b.file));
    
    // For backups 7-30 days old, keep weekly backups
    const weeklyBackups = [];
    let currentWeek = null;
    
    for (const backup of olderBackups) {
      if (backup.timestamp >= oneMonthAgo) {
        const backupWeek = getWeekNumber(backup.date);
        
        if (currentWeek !== backupWeek) {
          weeklyBackups.push(backup);
          currentWeek = backupWeek;
        }
      }
    }
    
    console.log(`   - Keeping ${weeklyBackups.length} weekly backups from the last month`);
    weeklyBackups.forEach(b => toKeep.add(b.file));
    
    // For backups older than a month, keep monthly backups
    const monthlyBackups = [];
    let currentMonth = null;
    
    for (const backup of olderBackups) {
      if (backup.timestamp < oneMonthAgo) {
        const backupMonth = backup.date.getMonth() + '-' + backup.date.getFullYear();
        
        if (currentMonth !== backupMonth) {
          monthlyBackups.push(backup);
          currentMonth = backupMonth;
        }
      }
    }
    
    console.log(`   - Keeping ${monthlyBackups.length} monthly backups from older periods`);
    monthlyBackups.forEach(b => toKeep.add(b.file));
    
    // Delete backups we don't need to keep
    const toDelete = backups.filter(b => !toKeep.has(b.file));
    
    if (toDelete.length > 0) {
      console.log(`🗑️  Pruning ${toDelete.length} old backups...`);
      
      toDelete.forEach(backup => {
        try {
          fs.unlinkSync(backup.path);
          console.log(`   - Deleted ${backup.file}`);
        } catch (err) {
          console.error(`   ❌ Error deleting ${backup.file}:`, err.message);
        }
      });
    } else {
      console.log('🧹 No backups need to be pruned at this time');
    }
  });
}

// Helper function to get week number
function getWeekNumber(date) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
}