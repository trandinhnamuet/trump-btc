#!/usr/bin/env node
/**
 * Script to remove unanalyzed posts from posts.json
 * Keeps only posts that have btcInfluenceProbability value
 * New posts will still be cached and analyzed by backfill logic
 */
const fs = require('fs');
const path = require('path');

const postsFile = path.join(__dirname, '../data/posts.json');

try {
  const data = JSON.parse(fs.readFileSync(postsFile, 'utf-8'));
  const originalCount = data.posts.length;
  
  // Filter: keep only posts with btcInfluenceProbability value
  data.posts = data.posts.filter(
    (p) => p.btcInfluenceProbability !== null && p.btcInfluenceProbability !== undefined
  );
  
  const removedCount = originalCount - data.posts.length;
  
  // Write back
  fs.writeFileSync(postsFile, JSON.stringify(data, null, 2), 'utf-8');
  
  console.log(`✅ Cleaned up unanalyzed posts:`);
  console.log(`   📊 Before: ${originalCount} posts`);
  console.log(`   🗑️  Removed: ${removedCount} unanalyzed posts`);
  console.log(`   📝 After: ${data.posts.length} posts`);
  console.log(`\n📌 Backfill logic is enabled - new unanalyzed posts will still be analyzed on startup`);
  
  process.exit(0);
} catch (error) {
  const errMsg = error instanceof Error ? error.message : String(error);
  console.error('❌ Error:', errMsg);
  process.exit(1);
}
