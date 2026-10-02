process.env.NODE_ENV='test';
const mongoose=require('mongoose');
const _stub=require('./services/compliance/__tests__/_stubMongo');
const _oid=()=>new mongoose.Types.ObjectId();
const models=['User','Leave','Submission','Attendance','Holiday','Template','Assignment','DependencyTask','Penalty','Notification','ComplianceRule','ComplianceEvent','ComplianceActionEffect','MarksLedger','FinancialLedger','PercentageLedger','AttendanceLedger','AuditLog','Event'];
models.forEach(m=>_stub.install(require('./models/'+m)));
_stub.install(require('./models/ComplianceIncident'),{uniqueBy:[{keys:['naturalKey'],filter:{source:'automatic'}}]});
const User=require('./models/User');
const lc=require('./controllers/leaveController');
(async()=>{
  const emp=await User.create({_id:_oid(),name:'E',employeeId:'E1',email:'e@x',password:'p',role:'employee',status:'active',weeklyOff:[0],leaveBalance:{yearlyAllowance:30,used:0}});
  const res={statusCode:200,status(n){this.statusCode=n;return this;},json(v){this.body=v;return this;}};
  await lc.apply({body:{fromDate:'2026-09-14',toDate:'2026-09-16',leaveType:'casual'},params:{},query:{},user:emp,ip:'1',get:()=>''},res,(e)=>{if(e)console.log('THREW:',e.message);});
  console.log('status',res.statusCode,'body',JSON.stringify(res.body));
})();
