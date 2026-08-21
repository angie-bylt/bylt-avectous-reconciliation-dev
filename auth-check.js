(async function(){
  try{
    const res = await fetch('/api/check-auth');
    const data = await res.json();
    if(!data.authorized){
      window.location.href = 'login.html';
    }
  } catch(err){
    // If this fails entirely (e.g. opening the file locally instead of via Netlify),
    // don't hard-block — just warn, since there's no login backend to check against yet.
    console.warn('Could not verify login — this page needs to be served by Netlify (with Functions) for the password gate to work.');
  }
})();
