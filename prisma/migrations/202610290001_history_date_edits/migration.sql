CREATE TABLE "HistoryDateEdit" (
 "id" TEXT NOT NULL PRIMARY KEY, "ownerId" TEXT NOT NULL, "activeOwnerKey" TEXT,
 "scope" TEXT NOT NULL, "mode" TEXT NOT NULL, "timezone" TEXT NOT NULL,
 "status" TEXT NOT NULL DEFAULT 'draft', "errorCode" TEXT, "confirmedAt" DATETIME,
 "retryAt" DATETIME, "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
 "updatedAt" DATETIME NOT NULL,
 CONSTRAINT "HistoryDateEdit_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "Owner" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "HistoryDateEdit_activeOwnerKey_key" ON "HistoryDateEdit"("activeOwnerKey");
CREATE INDEX "HistoryDateEdit_ownerId_createdAt_idx" ON "HistoryDateEdit"("ownerId", "createdAt");
CREATE TABLE "HistoryDateEditItem" (
 "id" TEXT NOT NULL PRIMARY KEY, "operationId" TEXT NOT NULL, "oldEventId" TEXT NOT NULL,
 "mediaId" TEXT NOT NULL, "episodeId" TEXT, "targetId" TEXT NOT NULL,
 "title" TEXT NOT NULL, "season" INTEGER, "episode" INTEGER,
 "oldWatchedAt" DATETIME, "newWatchedAt" DATETIME NOT NULL,
 "status" TEXT NOT NULL DEFAULT 'pending', "errorCode" TEXT,
 "originalJson" TEXT NOT NULL, "baselineIds" TEXT,
 "deleteSentAt" DATETIME, "addSentAt" DATETIME, "newEventId" TEXT,
 "updatedAt" DATETIME NOT NULL,
 CONSTRAINT "HistoryDateEditItem_operationId_fkey" FOREIGN KEY ("operationId") REFERENCES "HistoryDateEdit" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "HistoryDateEditItem_operationId_oldEventId_key" ON "HistoryDateEditItem"("operationId", "oldEventId");
CREATE INDEX "HistoryDateEditItem_operationId_status_idx" ON "HistoryDateEditItem"("operationId", "status");
