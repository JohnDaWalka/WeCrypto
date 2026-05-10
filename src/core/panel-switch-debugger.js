/**
 * Debug: Test panel switching
 * Run in DevTools console: window.testPanelSwitch()
 */

window.testPanelSwitch = function() {
  console.group('[Panel Switch Test]');
  
  // Check if render function exists
  if (typeof window._predictions === 'undefined') {
    console.log('Initializing global state...');
    window._predictions = {};
  }
  
  // Test: Get all nav buttons
  const btns = document.querySelectorAll('.nav-btn');
  console.log(`Found ${btns.length} nav buttons:`, Array.from(btns).map(b => b.dataset.view));
  
  // Test: Get content div
  const content = document.getElementById('content');
  console.log(`Content div exists:`, !!content);
  console.log(`Content div is visible:`, content?.offsetHeight > 0);
  
  // Test: Check current view state
  console.log('Attempting to read app state...');
  
  // Trigger a click on each nav button and log what happens
  btns.forEach((btn, i) => {
    setTimeout(() => {
      console.log(`\n--- Click test ${i+1}: ${btn.dataset.view} ---`);
      console.log('Before click:');
      console.log(`  Content HTML length: ${content.innerHTML.length}`);
      console.log(`  Content first 100 chars: ${content.innerHTML.substring(0, 100)}`);
      
      btn.click();
      
      setTimeout(() => {
        console.log('After click:');
        console.log(`  Content HTML length: ${content.innerHTML.length}`);
        console.log(`  Content first 100 chars: ${content.innerHTML.substring(0, 100)}`);
        console.log(`  Button active state: ${btn.classList.contains('active')}`);
      }, 100);
    }, i * 1500);
  });
  
  console.groupEnd();
};

console.log('[Debug] Panel switch test loaded. Run: window.testPanelSwitch()');
