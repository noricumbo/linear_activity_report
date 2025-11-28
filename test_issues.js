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

async function testIssues(userEmail, daysBack = 180) {
  try {
    console.log(`\n🔍 Testing issues API for: ${userEmail}\n`);
    
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
    
    user = allUsers.find(u => 
      u.email && u.email.toLowerCase() === userEmail.toLowerCase()
    );
    
    if (!user) {
      console.log('❌ User not found');
      return;
    }
    
    console.log(`   ✅ Found user: ${user.name} (${user.id})\n`);
    
    const since = new Date();
    since.setDate(since.getDate() - daysBack);
    console.log(`📅 Testing with date filter: last ${daysBack} days (since ${since.toISOString()})\n`);
    
    // Test 1: Get ALL issues (no filter)
    console.log('2. Testing: Get ALL issues (no filter, first 10)...');
    try {
      const allIssues = await linearClient.issues({ first: 10 });
      console.log(`   ✅ Success! Found ${allIssues.nodes.length} issues (showing first 10)`);
      if (allIssues.nodes.length > 0) {
        const sample = allIssues.nodes[0];
        const assignee = await sample.assignee;
        const creator = await sample.creator;
        const state = await sample.state;
        console.log(`   Sample issue:`);
        console.log(`   - ${sample.identifier}: ${sample.title}`);
        console.log(`   - Assignee: ${assignee?.name || 'Unassigned'} (${assignee?.email || 'N/A'})`);
        console.log(`   - Creator: ${creator?.name} (${creator?.email || 'N/A'})`);
        console.log(`   - State: ${state?.name}`);
        console.log(`   - Created: ${sample.createdAt}`);
        console.log(`   - Updated: ${sample.updatedAt}`);
      }
    } catch (err) {
      console.log(`   ❌ Error: ${err.message}`);
    }
    
    // Test 2: Get issues assigned to user
    console.log('\n3. Testing: Get issues ASSIGNED to user...');
    try {
      const assignedIssues = await linearClient.issues({
        filter: {
          assignee: { id: { eq: user.id } },
          updatedAt: { gte: since },
        },
        first: 50,
      });
      console.log(`   ✅ Success! Found ${assignedIssues.nodes.length} issues assigned to this user`);
      if (assignedIssues.nodes.length > 0) {
        console.log(`   Issues assigned:`);
        for (const issue of assignedIssues.nodes) {
          const state = await issue.state;
          console.log(`   - ${issue.identifier}: ${issue.title}`);
          console.log(`     State: ${state?.name}`);
          console.log(`     Updated: ${issue.updatedAt}`);
        }
      } else {
        console.log('   ⚠️  No assigned issues found in date range');
      }
    } catch (err) {
      console.log(`   ❌ Error: ${err.message}`);
      console.log(`   Error details:`, err);
    }
    
    // Test 3: Get issues assigned to user WITHOUT date filter
    console.log('\n4. Testing: Get issues ASSIGNED to user (NO date filter)...');
    try {
      const allAssignedIssues = await linearClient.issues({
        filter: {
          assignee: { id: { eq: user.id } },
        },
        first: 50,
      });
      console.log(`   ✅ Success! Found ${allAssignedIssues.nodes.length} total issues assigned (no date filter)`);
      if (allAssignedIssues.nodes.length > 0) {
        console.log(`   First 10 assigned issues:`);
        for (const issue of allAssignedIssues.nodes.slice(0, 10)) {
          const state = await issue.state;
          console.log(`   - ${issue.identifier}: ${issue.title} [${state?.name}]`);
          console.log(`     Updated: ${issue.updatedAt}`);
        }
      }
    } catch (err) {
      console.log(`   ❌ Error: ${err.message}`);
    }
    
    // Test 4: Get issues created by user
    console.log('\n5. Testing: Get issues CREATED by user...');
    try {
      const createdIssues = await linearClient.issues({
        filter: {
          creator: { id: { eq: user.id } },
          updatedAt: { gte: since },
        },
        first: 50,
      });
      console.log(`   ✅ Success! Found ${createdIssues.nodes.length} issues created by this user`);
      if (createdIssues.nodes.length > 0) {
        createdIssues.nodes.forEach((issue, idx) => {
          console.log(`   ${idx + 1}. ${issue.identifier}: ${issue.title}`);
          console.log(`      Created: ${issue.createdAt}`);
        });
      } else {
        console.log('   ⚠️  No created issues found in date range');
      }
    } catch (err) {
      console.log(`   ❌ Error: ${err.message}`);
    }
    
    // Test 5: Get issues where user is a participant (commented on)
    console.log('\n6. Testing: Get issues where user has COMMENTED...');
    try {
      // First get user's comments
      const userComments = await linearClient.comments({
        filter: {
          user: { id: { eq: user.id } },
          createdAt: { gte: since },
        },
        first: 100,
      });
      
      const issueIds = new Set();
      for (const comment of userComments.nodes) {
        const issue = await comment.issue;
        if (issue) {
          issueIds.add(issue.id);
        }
      }
      
      console.log(`   ✅ Found ${issueIds.size} unique issues where user commented`);
      if (issueIds.size > 0) {
        console.log(`   Issue IDs: ${Array.from(issueIds).slice(0, 10).join(', ')}`);
      }
    } catch (err) {
      console.log(`   ❌ Error: ${err.message}`);
    }
    
    // Test 6: Check issue states (to see if "Done" or "Solved" states exist)
    console.log('\n7. Testing: Check available issue states...');
    try {
      const workflowStates = await linearClient.workflowStates({ first: 50 });
      console.log(`   ✅ Found ${workflowStates.nodes.length} workflow states`);
      console.log(`   States:`);
      workflowStates.nodes.forEach(state => {
        console.log(`   - ${state.name} (type: ${state.type})`);
      });
    } catch (err) {
      console.log(`   ❌ Error: ${err.message}`);
    }
    
    // Test 7: Get issues assigned with different state filters
    console.log('\n8. Testing: Get issues assigned (checking different state types)...');
    try {
      // Try to get issues in "Done" or "Canceled" states
      const doneIssues = await linearClient.issues({
        filter: {
          assignee: { id: { eq: user.id } },
          state: { type: { in: ['completed', 'canceled'] } },
          updatedAt: { gte: since },
        },
        first: 50,
      });
      console.log(`   ✅ Found ${doneIssues.nodes.length} completed/canceled issues assigned to user`);
      if (doneIssues.nodes.length > 0) {
        doneIssues.nodes.forEach(issue => {
          console.log(`   - ${issue.identifier}: ${issue.title}`);
        });
      }
    } catch (err) {
      console.log(`   ⚠️  Could not filter by state type: ${err.message}`);
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
const daysBack = parseInt(process.argv[3]) || 180;

if (!userEmail) {
  console.error('❌ Please provide a user email:');
  console.error('   node test_issues.js user@example.com [daysBack]');
  process.exit(1);
}

testIssues(userEmail, daysBack);

