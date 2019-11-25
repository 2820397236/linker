const knex = appRequire('init/knex').knex;
const log4js = require('log4js');
const logger = log4js.getLogger('giftcard');
const uuidv4 = require('uuid/v4');
const account = appRequire('plugins/account/index');
const orderPlugin = appRequire('plugins/webgui_order');
const payMingboPlugin = appRequire('plugins/payMingbo');
const ref = appRequire('plugins/webgui_ref/time');
const moment = require('moment');

const dbTableName = require('./db/giftcard').tableName;

const cardType = {
	hourly: 5,
	daily: 4,
	weekly: 2,
	monthly: 3,
	quarterly: 6,
	yearly: 7
};

const cardStatusEnum = {
	available: 'AVAILABLE',
	sended: 'SENDED',
	used: 'USED',
	revoked: 'REVOKED'
};

const batchStatusEnum = {
	available: 'AVAILABLE',
	sended: 'SENDED',
	usedup: 'USEDUP',
	revoked: 'REVOKED'
};

const generateGiftCard = async (count, orderType, comment = '',sku, limit, cutPrice, mingboType) => {
	const currentCount = (await knex(dbTableName).count('* as cnt'))[0].cnt;
	const batchNumber = currentCount === 0 ? 1 :
		((await knex(dbTableName).max('batchNumber as mx'))[0].mx + 1);
	const cards = [];
	for (let i = 0; i < count; i++) {
		const password = uuidv4().replace(/\-/g, '').substr(0, 18);
		cards.push({
			orderType,
			status: cardStatusEnum.available,
			batchNumber,
			password,
			createTime: Date.now(),
			comment,
			sku,
			limit,
			cutPrice,
			mingboType
		});
	}
	await knex(dbTableName).insert(cards);
	logger.debug(`Inserted ${ count } gift card`);
	return batchNumber;
};

const sendSuccessMail = async userId => {
	const emailPlugin = appRequire('plugins/email/index');
	const user = await knex('user').select().where({
		type: 'normal',
		id: userId,
	}).then(success => {
		if (success.length) {
			return success[0];
		}
		return Promise.reject('user not found');
	});
	const orderMail = await knex('webguiSetting').select().where({
		key: 'mail',
	}).then(success => {
		if (!success.length) {
			return Promise.reject('settings not found');
		}
		success[0].value = JSON.parse(success[0].value);
		return success[0].value.order;
	});
	await emailPlugin.sendMail(user.email, orderMail.title, orderMail.content);
};

const processOrder = async (userId, accountId, password) => {
	const cardResult = await knex(dbTableName).where({ password }).select();
	if (cardResult.length === 0) {
		return { success: false, message: '优惠券不存在' };
	}
	const card = cardResult[0];
	if (card.status !== cardStatusEnum.available) {
		return { success: false, message: '无法使用这个优惠券' };
	}
	await knex(dbTableName).where({ id: card.id }).update({
		user: userId,
		account: accountId,
		status: cardStatusEnum.used,
		usedTime: Date.now()
	});
	const orderInfo = await payMingboPlugin.getOneOrder(card.orderType);
	await account.setAccountLimit(userId, accountId, card.orderType);
	await ref.payWithRef(userId, card.orderType);
	return { success: true, type: card.orderType, cardId: card.id ,status: cardStatusEnum.used, password: password};
};

const processOrderForMingboUser = async (userInfo, accountId, password) => {
	const cardResult = await knex(dbTableName).where({ password }).select();
	if (cardResult.length === 0) {
		return { success: false, message: '优惠券不存在' };
	}
	const card = cardResult[0];
	if (card.status !== cardStatusEnum.available) {
		return { success: false, message: '无法使用这个优惠券' };
	}
	const result = await payMingboPlugin.createOrderForMingboUser(userInfo, accountId, card.sku, card.limit , card);

	await knex(dbTableName).where({ id: card.id }).update({
		user: userInfo.id,
		account: accountId,
		status: cardStatusEnum.used,
		orderId: result.orderId,
		usedTime: Date.now(),
	});

	//const orderInfo = await orderPlugin.getOneOrder(card.orderType);
	//await account.setAccountLimit(userId, accountId, card.orderType);
	//await ref.payWithRef(userId, card.orderType);
	return { success: true, data: result};
};

const processBind = async (userId, accountId, card, serverId="") => {
	// const cardResult = await knex(dbTableName).whereIn({ password }).select();
	// if (cardResult.length === 0) {
	// 	return { success: false, message: '充值码不存在' };
	// }
	// const card = cardResult[0];
	// if (card.status !== cardStatusEnum.available && card.user !== null) {
	// 	return { success: false, message: '充值码已赠送' };
	// }
	await knex(dbTableName).where({ id: card.id }).update({
		user: userId,
		serverId: serverId,
		usedTime: Date.now()
	});
	//return { success: true, data: { cardId: card.id , sku: card.sku, comment:card.comment , password: card.password, type:card.mingboType}};
	return { success: true, cardId: card.id ,  password: card.password, status: card.status, type:card.mingboType, serverId:serverId, sku: card.sku,comment:card.comment };
};

const processBindAuto = async (userId, accountId, mingboType,serverId="") => {
	
	const cardResult = await knex(dbTableName).where({ mingboType, status: cardStatusEnum.available ,usedTime:null }).select();
	console.log(cardResult);
	if (cardResult.length === 0) {
		return { success: false, message: '优惠券type不存在或已用完，请联系lynca' };
	}
	const card = cardResult[0];
	if (card.status !== cardStatusEnum.available && card.user !== null) {
		return { success: false, message: '优惠券已赠送' };
	}

	const result = await processBind(userId, accountId, card ,serverId);

	return result;
};

const searchGiftcard = async (userId,status = null) =>{

	let cardResult;
	if(status == null){
		cardResult= await knex(dbTableName).where({ user:userId }).select();
	}else{
		cardResult= await knex(dbTableName).where({ user:userId,status: status }).select();
	}
	
	const data = cardResult.map(o =>{
		return {
			password : o.password,
			status: o.status,
			type: o.mingboType,
			comment: o.comment,
			cutPrice: o.cutPrice,
			orderId: o.orderId,
			usedTime: o.usedTime,
			expireTime: o.expireTime
		}
	});

	return { success: true, data: data};
}

const orderListAndPaging = async (options = {}) => {
	const search = options.search || '';
	const filter = options.filter || [];
	const group = options.group;
	const sort = options.sort || `${dbTableName}.createTime_desc`;
	const page = options.page || 1;
	const pageSize = options.pageSize || 20;
	const start = options.start ? moment(options.start).hour(0).minute(0).second(0).millisecond(0).toDate().getTime() : moment(0).toDate().getTime();
	const end = options.end ? moment(options.end).hour(23).minute(59).second(59).millisecond(999).toDate().getTime() : moment().toDate().getTime();

	const where = {};
	where[dbTableName + '.status'] = cardStatusEnum.used;
	let count = knex(dbTableName).select([]).where(where).whereBetween(`${dbTableName}.usedTime`, [start, end]);
	let orders = knex(dbTableName).select([
		`${dbTableName}.password as orderId`,
		`${dbTableName}.orderType`,
		`${dbTableName}.comment as orderName`,
		'user.id as userId',
		'user.username',
		'account_plugin.port',
		`${dbTableName}.status`,
		`${dbTableName}.usedTime as createTime`,
	])
	.where(where)
	.orderBy(`${dbTableName}.usedTime`, 'DESC')
	.leftJoin('user', 'user.id', `${dbTableName}.user`)
	.leftJoin('account_plugin', 'account_plugin.id', `${dbTableName}.account`)
	.leftJoin('webgui_order', 'webgui_order.id', `${dbTableName}.orderType`)
	.whereBetween(`${dbTableName}.usedTime`, [start, end]);

	if (filter.length) {
		count = count.whereIn(`${dbTableName}.status`, filter);
		orders = orders.whereIn(`${dbTableName}.status`, filter);
	}
	if(group >= 0) {
		count = count.leftJoin('user', 'user.id', `${dbTableName}.user`).where({ 'user.group': group });
		orders = orders.where({ 'user.group': group });
	}
	if (search) {
		count = count.where(`${dbTableName}.password`, 'like', `%${search}%`);
		orders = orders.where(`${dbTableName}.password`, 'like', `%${search}%`);
	}

	count = await count.count(`${dbTableName}.id as count`).then(success => success[0].count);
	orders = await orders.orderBy(sort.split('_')[0], sort.split('_')[1]).limit(pageSize).offset((page - 1) * pageSize);
	const maxPage = Math.ceil(count / pageSize);
	return {
		total: count,
		page,
		maxPage,
		pageSize,
		orders,
	};
};


const checkGitcard = async (password)=>{
	const giftcard = await knex(dbTableName).select().where({ password });
	if (order.length > 0) {
		return success[0];
	} else {
		return null;
	}
}

const checkOrder = async (id) => {
	const order = await knex(dbTableName).select().where({ id });
	if (order.length > 0) {
		return success[0].status;
	} else {
		return null;
	}
};

const generateBatchInfo = (x) => {
	let status;
	if (x.status === cardStatusEnum.revoked)
		status = batchStatusEnum.revoked;
	else {
		if (x.availableCount > 0)
			status = batchStatusEnum.available;
		else
			status = batchStatusEnum.usedup;
	}
	return {
		orderName: x.orderName,
		batchNumber: x.batchNumber,
		status: status,
		type: x.orderType,
		createTime: x.createTime,
		comment: x.comment,
		sku: x.sku,
		limit: x.limit,
		cutPrice: x.cutPrice,
		mingboType: x.mingboType,
		totalCount: x.totalCount,
		availableCount: x.availableCount
	};
};

const listBatch = async () => {
	const sqlResult = await knex(dbTableName).select([
		'webgui_order.name as orderName',
		`${ dbTableName }.batchNumber`,
		`${ dbTableName }.status as status`,
		`${ dbTableName }.orderType as orderType`,
		`${ dbTableName }.createTime as createTime`,
		`${ dbTableName }.comment as comment`,
		`${ dbTableName }.sku as sku`,
		`${ dbTableName }.limit as limit`,
		`${ dbTableName }.cutPrice as cutPrice`,
		`${ dbTableName }.mingboType as mingboType`,
		knex.raw('COUNT(*) as totalCount'),
		knex.raw(`COUNT(case status when '${cardStatusEnum.available}' then 1 else null end) as availableCount`)
	])
	.groupBy('batchNumber')
	.leftJoin('webgui_order', `${dbTableName}.orderType`, 'webgui_order.id');
	const finalResult = sqlResult.map(generateBatchInfo);
	return finalResult;
};

const getBatchDetails = async (batchNumber) => {
	const sqlBatchResult = await knex(dbTableName).select([
		'webgui_order.name as orderName',
		`${ dbTableName }.batchNumber`,
		`${ dbTableName }.status as status`,
		`${ dbTableName }.orderType as orderType`,
		`${ dbTableName }.createTime as createTime`,
		`${ dbTableName }.comment as comment`,
		`${ dbTableName }.sku as sku`,
		`${ dbTableName }.limit as limit`,
		`${ dbTableName }.cutPrice as cutPrice`,
		`${ dbTableName }.mingboType as mingboType`,
		knex.raw('COUNT(*) as totalCount'),
		knex.raw(`COUNT(case status when '${cardStatusEnum.available}' then 1 else null end) as availableCount`)
	])
	.where({ batchNumber })
	.leftJoin('webgui_order', `${dbTableName}.orderType`, 'webgui_order.id');
	if (sqlBatchResult.length == 0) { return null; }
		
	const batchInfo = generateBatchInfo(sqlBatchResult[0]);

	const sqlCardsResult = await knex(dbTableName).select([
		`${dbTableName}.id as id`,
		`${dbTableName}.status as status`,
		`${dbTableName}.usedTime as usedTime`,
		`${dbTableName}.password as password`,
		'account_plugin.port as portNumber',
		'user.email as userEmail',
		'user.username as user'
	])
		.where({ batchNumber: batchNumber })
		.leftJoin('account_plugin', `${dbTableName}.account`, 'account_plugin.id')
		.leftJoin('user', `${dbTableName}.user`, 'user.id');

	return Object.assign(batchInfo, { cards: sqlCardsResult });
};

const revokeBatch = async batchNumber => {
	await knex(dbTableName).where({
		batchNumber,
		status: cardStatusEnum.available,
	}).update({ status: cardStatusEnum.revoked });
};

const getUserOrders = async userId => {
	const orders = await knex(dbTableName).select([
		`${dbTableName}.password as password`,
		`${dbTableName}.orderId as orderId`,
		`${dbTableName}.orderType`,
		`${dbTableName}.comment`,
		'user.id as userId',
		'user.username',
		'account_plugin.port',
		`${dbTableName}.status`,
		`${dbTableName}.usedTime as createTime`,
	])
	.where({ 'user.id': userId })
	.orderBy(`${dbTableName}.usedTime`, 'DESC')
	.leftJoin('user', 'user.id', `${dbTableName}.user`)
	.leftJoin('account_plugin', 'account_plugin.id', `${dbTableName}.account`);
	return orders;
};

const getUserFinishOrder = async userId => {
	let orders = await knex('giftcard').select([
		'password as orderId',
		'createTime',
	]).where({
		user: userId,
	}).orderBy('createTime', 'DESC');
	orders = orders.map(order => {
		return {
			orderId: order.orderId,
			type: '优惠券',
			createTime: order.createTime,
		};
	});
	return orders;
};

const setCardFinish = async (userId,accountId,password) =>{
	await knex(dbTableName).where({ password }).update({
		user: userId,
		account: accountId,
		status: cardStatusEnum.used,
		usedTime: Date.now()
	});
}


const getOneByPassword = async(password)=>{
	const card = await knex(dbTableName).select().where({ password });
	return card.length > 0 ? card[0] : null;
}

exports.generateGiftCard = generateGiftCard;
exports.orderListAndPaging = orderListAndPaging;
exports.checkOrder = checkOrder;
exports.processOrder = processOrder;
exports.revokeBatch = revokeBatch;
exports.listBatch = listBatch;
exports.getBatchDetails = getBatchDetails;
exports.getUserOrders = getUserOrders;
exports.getUserFinishOrder = getUserFinishOrder;

exports.processBind = processBind;
exports.processBindAuto = processBindAuto;
exports.processOrderForMingboUser = processOrderForMingboUser;
exports.searchGiftcard = searchGiftcard;
exports.getOneByPassword = getOneByPassword;
exports.setCardFinish = setCardFinish;
