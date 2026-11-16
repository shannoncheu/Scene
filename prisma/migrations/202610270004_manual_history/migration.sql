-- CreateTable
CREATE TABLE "ManualHistoryIntent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "ownerId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "targetTraktId" TEXT NOT NULL,
    "showTraktId" TEXT,
    "season" INTEGER,
    "episode" INTEGER,
    "watchedAt" DATETIME NOT NULL,
    "timezone" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "year" INTEGER,
    "posterPath" TEXT,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "errorCode" TEXT,
    "remoteEventId" TEXT,
    "sentAt" DATETIME,
    "confirmedAt" DATETIME,
    "leaseExpiresAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ManualHistoryIntent_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "Owner" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "ManualHistoryIntent_ownerId_status_createdAt_idx" ON "ManualHistoryIntent"("ownerId", "status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "ManualHistoryIntent_ownerId_kind_targetTraktId_watchedAt_key" ON "ManualHistoryIntent"("ownerId", "kind", "targetTraktId", "watchedAt");

