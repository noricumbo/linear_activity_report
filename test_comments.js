import 'dotenv/config';
import { LinearClient } from '@linear/sdk';

// Load API key from environment variable
const apiKey = process.env.LINEAR_API_KEY;
const accessToken = process.env.LINEAR_ACCESS_TOKEN;

if (!apiKey && !accessToken) {
  throw new Error('Please set either LINEAR_API_KEY or LINEAR_ACCESS_TOKEN in your .env file');
}

// With Personal API Key or OAuth 2.0 Access Token
const linearClient = apiKey 
  ? new LinearClient({ apiKey })
  : new LinearClient({ accessToken });

async function testComments(userEmail) {
  try {
    console.log(`\n🔍 Testing comments API for: ${userEmail}\n`);
    
    // First, find the user
    console.log('1. Finding user...');
    let user = null;
    let hasNextPage = true;
    let after = null;
    const allUsers = [];
    
    while (hasNextPage) {
      const usersResponse = await linearClient.users({
        first: 50,
        ...(after && { after }),
      });
      
      allUsers.push(...usersResponse.nodes);
      hasNextPage = usersResponse.pageInfo.hasNextPage;
      after = usersResponse.pageInfo.endCursor;
    }
    
    console.log(`   Found ${allUsers.length} users in workspace`);
    
    user = allUsers.find(u => 
      u.email && u.email.toLowerCase() === userEmail.toLowerCase()
    );
    
    if (!user) {
      console.log('\n❌ User not found. Available users (first 10):');
      allUsers.slice(0, 10).forEach(u => {
        console.log(`   - ${u.name} (${u.email || 'no email'})`);
      });
      return;
    }
    
    console.log(`   ✅ Found user: ${user.name} (${user.id})\n`);
    
    // Test 1: Get ALL comments (no filter)
    console.log('2. Testing: Get ALL comments (no filter)...');
    try {
      const allComments = await linearClient.comments({ first: 10 });
      console.log(`   ✅ Success! Found ${allComments.nodes.length} comments (showing first 10)`);
      if (allComments.nodes.length > 0) {
        console.log('   Sample comment:');
        const sample = allComments.nodes[0];
        const commentUser = await sample.user;
        const commentIssue = await sample.issue;
        console.log(`   - User: ${commentUser?.name} (${commentUser?.email || 'no email'})`);
        console.log(`   - Issue: ${commentIssue?.identifier} - ${commentIssue?.title}`);
        console.log(`   - Body: ${sample.body?.substring(0, 50)}...`);
        console.log(`   - Created: ${sample.createdAt}`);
      }
    } catch (err) {
      console.log(`   ❌ Error: ${err.message}`);
    }
    
    // Test 2: Get comments filtered by user ID
    console.log('\n3. Testing: Get comments filtered by user ID...');
    try {
      const userComments = await linearClient.comments({
        filter: {
          user: { id: { eq: user.id } },
        },
        first: 10,
      });
      console.log(`   ✅ Success! Found ${userComments.nodes.length} comments by this user`);
      if (userComments.nodes.length > 0) {
        userComments.nodes.forEach((comment, idx) => {
          console.log(`   ${idx + 1}. Comment ID: ${comment.id}`);
          console.log(`      Body: ${comment.body?.substring(0, 80)}...`);
          console.log(`      Created: ${comment.createdAt}`);
        });
      } else {
        console.log('   ⚠️  No comments found for this user');
      }
    } catch (err) {
      console.log(`   ❌ Error: ${err.message}`);
      console.log(`   Error details:`, err);
    }
    
    // Test 3: Get comments with date filter
    console.log('\n4. Testing: Get comments with date filter (last 30 days)...');
    try {
      const since = new Date();
      since.setDate(since.getDate() - 30);
      console.log(`   Filtering since: ${since.toISOString()}`);
      
      const recentComments = await linearClient.comments({
        filter: {
          user: { id: { eq: user.id } },
          createdAt: { gte: since },
        },
        first: 10,
      });
      console.log(`   ✅ Success! Found ${recentComments.nodes.length} comments in last 30 days`);
      if (recentComments.nodes.length > 0) {
        recentComments.nodes.forEach((comment, idx) => {
          console.log(`   ${idx + 1}. Created: ${comment.createdAt}`);
          console.log(`      Body: ${comment.body?.substring(0, 60)}...`);
        });
      }
    } catch (err) {
      console.log(`   ❌ Error: ${err.message}`);
      console.log(`   Error details:`, err);
    }
    
    // Test 4: Get comments without user filter (to see total)
    console.log('\n5. Testing: Get ALL comments (no user filter, last 30 days)...');
    try {
      const since = new Date();
      since.setDate(since.getDate() - 30);
      
      const allRecentComments = await linearClient.comments({
        filter: {
          createdAt: { gte: since },
        },
        first: 20,
      });
      console.log(`   ✅ Success! Found ${allRecentComments.nodes.length} total comments in last 30 days`);
      console.log('   Comments by user:');
      const commentsByUser = {};
      for (const comment of allRecentComments.nodes) {
        const commentUser = await comment.user;
        const userName = commentUser?.name || 'Unknown';
        commentsByUser[userName] = (commentsByUser[userName] || 0) + 1;
      }
      Object.entries(commentsByUser).forEach(([name, count]) => {
        console.log(`   - ${name}: ${count} comments`);
      });
    } catch (err) {
      console.log(`   ❌ Error: ${err.message}`);
    }
    
    console.log('\n' + '='.repeat(80));
    console.log('✅ Testing complete!\n');
    
  } catch (error) {
    console.error('❌ Error:', error);
    console.error('Stack:', error.stack);
  }
}

// Main execution
const userEmail = process.argv[2];
if (!userEmail) {
  console.error('❌ Please provide a user email:');
  console.error('   node test_comments.js user@example.com');
  process.exit(1);
}

testComments(userEmail);

