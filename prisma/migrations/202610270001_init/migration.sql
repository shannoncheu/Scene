-- CreateTable
CREATE TABLE "Owner" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "traktUserId" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "timezone" TEXT NOT NULL DEFAULT 'Asia/Shanghai',
    "encryptedAccessToken" TEXT,
    "encryptedRefreshToken" TEXT,
    "tokenExpiresAt" DATETIME,
    "avatarPath" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "Media" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "kind" TEXT NOT NULL,
    "originalTitle" TEXT NOT NULL,
    "chineseTitle" TEXT,
    "year" INTEGER,
    "tmdbId" TEXT,
    "runtime" INTEGER,
    "rating" REAL,
    "posterPath" TEXT,
    "metadataAt" DATETIME
);

-- CreateTable
CREATE TABLE "Episode" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "showId" TEXT NOT NULL,
    "season" INTEGER NOT NULL,
    "number" INTEGER NOT NULL,
    "title" TEXT,
    "runtime" INTEGER,
    CONSTRAINT "Episode_showId_fkey" FOREIGN KEY ("showId") REFERENCES "Media" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "WatchEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "ownerId" TEXT NOT NULL,
    "mediaId" TEXT NOT NULL,
    "episodeId" TEXT,
    "watchedAt" DATETIME NOT NULL,
    "importedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "action" TEXT,
    CONSTRAINT "WatchEvent_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "Owner" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "WatchEvent_mediaId_fkey" FOREIGN KEY ("mediaId") REFERENCES "Media" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "WatchEvent_episodeId_fkey" FOREIGN KEY ("episodeId") REFERENCES "Episode" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "SyncState" (
    "ownerId" TEXT NOT NULL PRIMARY KEY,
    "status" TEXT NOT NULL DEFAULT 'idle',
    "completedPage" INTEGER NOT NULL DEFAULT 0,
    "snapshotAt" DATETIME,
    "lastActivityAt" DATETIME,
    "lastSuccessfulAt" DATETIME,
    "lastReconciledAt" DATETIME,
    "leaseExpiresAt" DATETIME,
    "errorCode" TEXT,
    CONSTRAINT "SyncState_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "Owner" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "Owner_traktUserId_key" ON "Owner"("traktUserId");

-- CreateIndex
CREATE UNIQUE INDEX "Episode_showId_season_number_key" ON "Episode"("showId", "season", "number");

-- CreateIndex
CREATE INDEX "WatchEvent_ownerId_watchedAt_idx" ON "WatchEvent"("ownerId", "watchedAt");

-- CreateIndex
CREATE INDEX "WatchEvent_ownerId_mediaId_watchedAt_idx" ON "WatchEvent"("ownerId", "mediaId", "watchedAt");

-- CreateIndex
CREATE INDEX "WatchEvent_episodeId_idx" ON "WatchEvent"("episodeId");

