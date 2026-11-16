-- AlterTable
ALTER TABLE "Media" ADD COLUMN "airedEpisodes" INTEGER;
ALTER TABLE "Media" ADD COLUMN "description" TEXT;

-- AlterTable
ALTER TABLE "Owner" ADD COLUMN "refreshLeaseUntil" DATETIME;

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "ownerId" TEXT NOT NULL,
    "csrf" TEXT NOT NULL,
    "expiresAt" DATETIME NOT NULL,
    CONSTRAINT "Session_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "Owner" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "OAuthAttempt" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "verifier" TEXT NOT NULL,
    "expiresAt" DATETIME NOT NULL
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_SyncState" (
    "ownerId" TEXT NOT NULL PRIMARY KEY,
    "status" TEXT NOT NULL DEFAULT 'idle',
    "completedPage" INTEGER NOT NULL DEFAULT 0,
    "snapshotAt" DATETIME,
    "lastActivityAt" DATETIME,
    "lastSuccessfulAt" DATETIME,
    "lastReconciledAt" DATETIME,
    "leaseExpiresAt" DATETIME,
    "errorCode" TEXT,
    "runId" TEXT,
    "expectedCount" INTEGER,
    "completedCount" INTEGER NOT NULL DEFAULT 0,
    "retryAt" DATETIME,
    "metadataCursor" TEXT,
    "mode" TEXT,
    "rangeStart" TEXT,
    "capturedActivity" TEXT,
    CONSTRAINT "SyncState_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "Owner" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_SyncState" ("completedPage", "errorCode", "lastActivityAt", "lastReconciledAt", "lastSuccessfulAt", "leaseExpiresAt", "ownerId", "snapshotAt", "status") SELECT "completedPage", "errorCode", "lastActivityAt", "lastReconciledAt", "lastSuccessfulAt", "leaseExpiresAt", "ownerId", "snapshotAt", "status" FROM "SyncState";
DROP TABLE "SyncState";
ALTER TABLE "new_SyncState" RENAME TO "SyncState";
CREATE TABLE "new_WatchEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "ownerId" TEXT NOT NULL,
    "mediaId" TEXT NOT NULL,
    "episodeId" TEXT,
    "watchedAt" DATETIME,
    "importedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "action" TEXT,
    "seenRun" TEXT,
    CONSTRAINT "WatchEvent_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "Owner" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "WatchEvent_mediaId_fkey" FOREIGN KEY ("mediaId") REFERENCES "Media" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "WatchEvent_episodeId_fkey" FOREIGN KEY ("episodeId") REFERENCES "Episode" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_WatchEvent" ("action", "episodeId", "id", "importedAt", "mediaId", "ownerId", "watchedAt") SELECT "action", "episodeId", "id", "importedAt", "mediaId", "ownerId", "watchedAt" FROM "WatchEvent";
DROP TABLE "WatchEvent";
ALTER TABLE "new_WatchEvent" RENAME TO "WatchEvent";
CREATE INDEX "WatchEvent_ownerId_watchedAt_idx" ON "WatchEvent"("ownerId", "watchedAt");
CREATE INDEX "WatchEvent_ownerId_mediaId_watchedAt_idx" ON "WatchEvent"("ownerId", "mediaId", "watchedAt");
CREATE INDEX "WatchEvent_episodeId_idx" ON "WatchEvent"("episodeId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE INDEX "Session_expiresAt_idx" ON "Session"("expiresAt");

